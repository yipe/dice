import { native } from "../native";
import type { RollConfig } from "../../../../src/builder/types";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`key*`). The configs are arbitrary JS objects (a config
 * with an unknown field or a wrong-typed value takes the JSON fallback), so they cross as one tagged
 * tree: `["u"]` undefined, `["z"]` null, `["b", bool]`, `["n", number]`, `["s", string]`,
 * `["a", [value...]]`, `["o", [[key, value]...]]`. Numbers JSON cannot carry are strings.
 */

type Tagged = [string] | [string, unknown];

function tag(value: unknown): Tagged {
  switch (typeof value) {
    case "boolean":
      return ["b", value];
    case "number":
      return ["n", Object.is(value, -0) ? "-0" : Number.isFinite(value) ? value : String(value)];
    case "string":
      return ["s", value];
    case "object":
      if (value === null) return ["z"];
      if (Array.isArray(value)) return ["a", Array.from(value, tag)];
      return ["o", Object.keys(value).map((key) => [key, tag((value as Record<string, unknown>)[key])])];
    default:
      // undefined, functions and symbols: `JSON.stringify` skips them in objects.
      return ["u"];
  }
}

function tagConfigs(configs: readonly RollConfig[]): string {
  return JSON.stringify(tag(Array.from(configs)));
}

/** The original serializer, kept as the fallback for any config the fast path does not recognize. */
export function jsonRollKey(configs: readonly RollConfig[]): string {
  return native.keyJsonRoll(tagConfigs(configs)) as string;
}

/**
 * A key that identifies a roll's config array by value, without `JSON.stringify`. Equal values give
 * equal keys and equal keys mean equal field values; own-key order is ignored. A config with a field
 * or type it does not know falls back to {@link jsonRollKey}.
 */
export function rollConfigsKey(configs: readonly RollConfig[]): string {
  return native.keyRollConfigs(tagConfigs(configs)) as string;
}
