import { DiceParseError } from "../common/errors";
import { LRUCache } from "../common/lru-cache";
import type { OutcomeType } from "../common/types";
import type { PMF } from "../pmf/pmf";
import { Dice } from "./dice";

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
const parseCache = new LRUCache<string, PMF>(1000);

let cachingEnabled = true;

/** Enable or disable the internal parse cache. */
export function setCachingEnabled(enabled: boolean): void {
  cachingEnabled = enabled;
  if (!enabled) clearParserCache();
}

/** Returns whether the internal parse cache is currently enabled. */
export function getCachingEnabled(): boolean {
  return cachingEnabled;
}

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

  if (cachingEnabled) {
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
  if (cachingEnabled) {
    // store using the same cleaned key we used for lookup
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
 * (`a - b` as numbers); this subtracts raw face COUNTS, used to isolate "everything except this
 * natural-die-value's contribution" out of an already-convolved to-hit total.
 */
function subtractCounts(a: Dice, b: Dice): Dice {
  const result = new Dice();
  for (const [key, value] of a.getFaceEntries()) result.increment(key, value);
  for (const [key, value] of b.getFaceEntries()) result.increment(key, -value);
  return result;
}

function parseExpression(arr: string[], n: number): Dice {
  const result = (() => {
    const res = parseArgument(arr, n);
    return typeof res === "number" ? Dice.scalar(res) : res;
  })();

  let op = parseOperation(arr);
  let finalResult = result;

  // Track a flat (no advantage/disadvantage/reroll) base check die's natural-max face
  // separately from whatever bonus-to-hit dice and modifiers get added to it, so a later plain
  // `crit` clause -- possibly in an OUTER parseExpression call, once this AC-checked
  // sub-expression has already collapsed to one Dice -- can recover the exact "natural max, any
  // bonus roll" slice instead of peeling the combined expression's single highest TOTAL, which
  // undercounts crit mass whenever bonus dice are present (e.g. Bless: "d20 + 5 + 1d4" reported
  // a crit probability of 1/(20*4) instead of 1/20).
  //
  // Scoped narrowly and deliberately: only a bare flat `dN` base die with no reroll, combined
  // solely via `+`/`-`, terminated by a numeric `AC`/`DC` target. Anything else --
  // advantage/disadvantage/elven accuracy on the base die, halfling reroll, a dynamic
  // (dice-valued) AC target, or `xcrit` (an expanded crit RANGE, which needs its own AC check
  // per natural face) -- invalidates tracking and falls back to the legacy peel-based behavior,
  // which remains correct with no bonus dice and is the same known-imperfect approximation
  // otherwise. See CHANGELOG.
  let baseDieMeta =
    result.privateData?.checkDie && !result.privateData.checkDie.rerollOne
      ? result.privateData.checkDie
      : undefined;
  let bonusOnly = Dice.scalar(0);

  while (op != null) {
    const arg = !op.unary ? parseArgument(arr, n) : finalResult;

    let acAlreadyApplied = false;
    if (baseDieMeta) {
      if (op === Dice.prototype.addNonZero) {
        bonusOnly = bonusOnly.add(arg);
      } else if (op === Dice.prototype.subtract) {
        bonusOnly = bonusOnly.subtract(arg);
      } else if (op === Dice.prototype.ac && typeof arg === "number") {
        // Isolate the natural-max face's contribution BEFORE gating, so the crit clause can use
        // it directly (see below) -- but AC-gate it exactly like every other natural value (no
        // RAW "natural 20 always hits" exception here: that would change this checked total's
        // hit/miss math, not just crit attribution, and several tests pin the parser's existing
        // "AC is a pure numeric threshold, no natural-face exceptions" behavior, e.g. an
        // unreachably high AC yields zero mass even on a natural max). Splitting into two pieces
        // and re-gating each is mathematically identical to gating the whole, since `.ac()` acts
        // per-face independently.
        const natMaxSlice = bonusOnly.add(baseDieMeta.sides);
        const restSlice = subtractCounts(finalResult, natMaxSlice);
        const gatedNatMaxSlice = natMaxSlice.ac(arg);
        finalResult = restSlice.ac(arg).combine(gatedNatMaxSlice);
        finalResult.privateData.checkDie = baseDieMeta;
        finalResult.privateData.natMaxCritSlice = gatedNatMaxSlice;
        acAlreadyApplied = true;
        baseDieMeta = undefined;
      } else {
        baseDieMeta = undefined;
      }
    }

    // Handle crit (e.g. xcrit, crit)
    let crit: Dice | undefined;
    let critNorm = 1;
    if (arr[0] === "x" || arr[0] === "c") {
      const isXcrit = arr[0] === "x";
      if (isXcrit) assertToken(arr, "x");
      assertToken(arr, "c");
      assertToken(arr, "r");
      assertToken(arr, "i");
      assertToken(arr, "t");

      const count = isXcrit ? parseNumber(arr, n) : 1;
      const trackedCritSlice = finalResult.privateData?.natMaxCritSlice;

      if (count === 1 && trackedCritSlice) {
        // Exact path: trackedCritSlice already isolates "natural max, any bonus roll" (see the
        // AC-tracking block above), independent of how many bonus-to-hit dice sides would
        // otherwise smear that mass across several total values.
        crit = trackedCritSlice;
        finalResult = subtractCounts(finalResult, trackedCritSlice);
      } else {
        // KNOWN LIMITATION (xcrit, or no tracked base die -- advantage/disadvantage/elven
        // accuracy, halfling reroll, or bonus dice mixed into a non-flat check): peels the
        // maximum FACE of the already-convolved to-hit distribution. Correct only when the
        // to-hit has no bonus dice, since bonus dice otherwise smear a natural-max roll's mass
        // across several total values that also contain non-crit mass. Use the builder API
        // (d20.plus(...).plus(bonusDie).ac(...).onCrit(...)) for a correct crit probability with
        // bonus to-hit dice in these cases. See CHANGELOG.
        crit = new Dice();
        for (let i = 0; i < count; i++) {
          const max = finalResult.maxFace();
          crit.setFace(max, finalResult.get(max));
          finalResult = finalResult.deleteFace(max);
        }
      }

      critNorm = crit.total();
      crit = op.call(crit, parseBinaryArgument(arg, arr, n));

      critNorm = crit && critNorm ? crit.total() / critNorm : 1;
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

    if (!acAlreadyApplied) {
      finalResult = op.call(finalResult, arg);
    }
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

    op = parseOperation(arr);
  }

  return finalResult;
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

  result.privateData.checkDie = { sides, rerollOne };
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
