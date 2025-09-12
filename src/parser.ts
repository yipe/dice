import { Dice } from "./dice";
import { LRUCache } from "./lru-cache";
import type { PMF } from "./pmf";
import type { OutcomeType } from "./types";

type DiceOperation = ((this: Dice, other: Dice | number) => Dice) & {
  unary?: boolean;
};

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

  let result = undefined;
  try {
    result = parseExpression(chars, n);
  } catch (error) {
    throw new Error(`Cannot parse dice expression [${expression}]: ${error}`);
  }

  try {
    (result as any).privateData = (result as any).privateData || {};
    result.identifier = cleaned;
  } catch {}

  if (chars.length > 0) {
    throw new Error(
      `Unexpected token: '${chars[0]}' from expression: '${expression}'`
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

function parseExpression(arr: string[], n: number): Dice {
  const result = (() => {
    const res = parseArgument(arr, n);
    return typeof res === "number" ? Dice.scalar(res) : res;
  })();

  let op = parseOperation(arr);
  let finalResult = result;

  while (op != null) {
    const arg = !op.unary ? parseArgument(arr, n) : finalResult;

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

      crit = new Dice();
      for (let i = 0; i < count; i++) {
        const max = finalResult.maxFace();
        crit.setFace(max, finalResult.get(max));
        finalResult = finalResult.deleteFace(max);
      }

      critNorm = crit.total();
      crit = op.call(crit, parseBinaryArgument(arg, arr, n));

      critNorm = critNorm ? crit.total() / critNorm : 1;
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
      saveNorm = saveNorm ? save.total() / saveNorm : 1;
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

      const missAfter = pc.total();
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
      missNorm = missNorm ? miss.total() / missNorm : 1;
    }

    let norm = finalResult.total();

    finalResult = op.call(finalResult, arg);
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
  const faces: Record<number, Dice> = {};
  let normalizationFactor = 1;

  for (const key of d1.keys()) {
    let face: Dice;

    if (typeof key !== "number") {
      continue; // Skip invalid scalar
    }

    if (d2.privateData.keep) {
      // Repeat dice2 "key" times and apply keep
      const repeat: Dice[] = Array(key).fill(d2);
      face = opDice(repeat, d2.privateData.keep);
    } else {
      face = multiplyDice(key, d2);
    }

    normalizationFactor *= face.total();
    faces[key] = face;
  }

  for (const key of Object.keys(faces)) {
    const k = parseFloat(key); // keys from object are strings
    const face = faces[k];
    const count = d1.get(k);
    result.combineInPlace(
      face.normalize((count * normalizationFactor) / face.total())
    );
  }

  result.privateData.except = {};
  return result;
}

function multiplyDice(n: number, d: Dice): Dice {
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
  let result = new Dice(sides);

  if (rerollOne) {
    result = result.deleteFace(1).combine(result);
  }

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
