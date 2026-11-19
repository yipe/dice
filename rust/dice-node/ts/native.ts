import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * The napi addon (`rust/dice-node/dice.node`, built by `build.sh`). The handles are untyped here:
 * the facade classes in this directory are the typed surface; the handles' methods are the
 * `#[napi]` methods of `src/lib.rs`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const rawNative: {
  NativePmf: Any;
  NativeQuery: Any;
  NativeRoll: Any;
  NativeAttack: Any;
  NativeSave: Any;
  [name: string]: Any;
  parse(expression: string, n: number): Any;
  tryParse(expression: string): Any;
  withRollType(expression: string, rollType: string): string;
  scaleParsedDice(expression: string, scale: number): string;
} = createRequire(import.meta.url)(fileURLToPath(new URL("../dice.node", import.meta.url)));

/**
 * The class tag of an error the native side throws for a `DiceError` (`src/error.rs`): the message
 * of the native `Error` is {@link TAG} followed by this object as JSON. `class` is the TS class
 * name; the other fields are the ones that class carries.
 */
export interface NativeErrorTag {
  class: string;
  message: string;
  /** `DiceParseError`, `ParsedCheckError`. */
  expression?: string | null;
  /** `DiceParseError`: the error that triggered it. */
  cause?: NativeErrorTag | null;
  /** `ParsedCheckError`: `"ac"` or `"dc"`. */
  verb?: string;
  /** `TurnSpecError`. */
  code?: string;
  id?: string;
}

/** Builds the TS error of a tag. */
export type ErrorClass = (tag: NativeErrorTag) => Error;

const TAG = "\u0001dice:";

const classes = new Map<string, ErrorClass>([
  ["Error", (tag) => new Error(tag.message)],
  ["RangeError", (tag) => new RangeError(tag.message)],
  ["TypeError", (tag) => new TypeError(tag.message)],
]);

/** Facade modules that define the library's own error classes register how to build them. */
export function registerErrorClass(name: string, build: ErrorClass): void {
  classes.set(name, build);
}

/** The TS error a native error tag stands for. */
export function errorOfTag(tag: NativeErrorTag): Error {
  return (classes.get(tag.class) ?? classes.get("Error")!)(tag);
}

/**
 * The error a native call throws as the TypeScript would: a tagged native error becomes its TS
 * class (see {@link NativeErrorTag}); anything else (a JS callback's own throw) is unchanged.
 */
export function translateError(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.startsWith(TAG)) return error;
  return errorOfTag(JSON.parse(error.message.slice(TAG.length)) as NativeErrorTag);
}

/** Runs a native call and rethrows its errors as the TS classes. */
export function fromNative<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw translateError(error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (this: unknown, ...args: any[]) => unknown;

function guard(original: Fn): Fn {
  return function (this: unknown, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch (error) {
      throw translateError(error);
    }
  };
}

/**
 * Wraps every instance method of a native class so its errors are translated, and returns a proxy
 * that does the same for its static factories (napi defines those non-configurable).
 */
function guardClass<C extends { prototype: object }>(cls: C): C {
  for (const name of Object.getOwnPropertyNames(cls.prototype)) {
    if (name === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(cls.prototype, name);
    if (desc && typeof desc.value === "function" && desc.configurable) {
      Object.defineProperty(cls.prototype, name, { ...desc, value: guard(desc.value as Fn) });
    }
  }
  const guarded = new Map<PropertyKey, unknown>();
  // A proxy over a dummy function: the napi class's own static properties are non-configurable,
  // and a proxy over the class itself could not return the guarded wrappers for them.
  return new Proxy(function () {} as unknown as C, {
    get(_dummy, key) {
      const value = Reflect.get(cls, key) as unknown;
      if (typeof value !== "function" || key === "prototype" || key === "constructor") return value;
      let wrapped = guarded.get(key);
      if (wrapped === undefined) {
        wrapped = guard((value as Fn).bind(cls));
        guarded.set(key, wrapped);
      }
      return wrapped;
    },
    construct(_dummy, args) {
      return Reflect.construct(cls as unknown as new (...a: unknown[]) => object, args);
    },
    has: (_dummy, key) => Reflect.has(cls, key),
  });
}

for (const key of Object.keys(rawNative)) {
  const value = rawNative[key] as unknown;
  if (typeof value !== "function") continue;
  rawNative[key] = /^Native/.test(value.name)
    ? guardClass(value as { prototype: object })
    : guard(value as Fn);
}

export const native = rawNative;

/** A native `NativePmf` handle. */
export type NativePmfHandle = Any;
/** A native `NativeAttack` handle. */
export type NativeAttackHandle = Any;
/** A native `NativeSave` handle. */
export type NativeSaveHandle = Any;
/** A native `NativeRoll` handle. */
export type NativeRollHandle = Any;
/** A native `NativeQuery` handle. */
export type NativeQueryHandle = Any;

