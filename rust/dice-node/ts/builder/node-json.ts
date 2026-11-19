import type { ExpressionNode } from "../../../../src/builder/nodes";

/**
 * The JSON text an `ExpressionNode` crosses the native boundary as (see `src/ast.rs`): the TS node
 * shape, with the numbers JSON cannot carry (`NaN`, `±Infinity`, `-0`) as strings.
 */

const SPECIAL: Record<string, number> = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 };

function numberOut(_key: string, value: unknown): unknown {
  if (typeof value !== "number") return value;
  if (Object.is(value, -0)) return "-0";
  return Number.isFinite(value) ? value : String(value);
}

function numberIn(_key: string, value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(SPECIAL, value) ? SPECIAL[value] : value;
}

/** @internal A node as the text the native functions read. */
export function nodeToJson(node: ExpressionNode): string {
  return JSON.stringify(node, numberOut);
}

/** @internal The node a native function wrote as text. */
export function nodeFromJson(json: string): ExpressionNode {
  return JSON.parse(json, numberIn) as ExpressionNode;
}

/** @internal Any JSON text a native function wrote, with the special numbers restored. */
export function parseNative<T>(json: string): T {
  return JSON.parse(json, numberIn) as T;
}
