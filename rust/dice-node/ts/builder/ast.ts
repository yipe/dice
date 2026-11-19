import { native, type NativePmfHandle } from "../native";
import { PMF } from "../pmf/pmf";
import type { DieNode, ExpressionNode, KeepNode } from "../../../../src/builder/nodes";
import type { RollConfig, RollType } from "../../../../src/builder/types";
import { AmbiguousKeepError } from "./errors";
import { nodeFromJson, nodeToJson, parseNative } from "./node-json";
import type { RollBuilder } from "./roll";

/**
 * Facade over `rust/dice-node/src/ast.rs`: roll configs to an expression tree and the tree to a
 * PMF. Nodes cross as JSON text (`./node-json`). The Rust crate keeps no single-die, d20-lift or
 * builder PMF caches, so there is nothing to clear.
 */

export { AmbiguousKeepError };

type KeepSpec = NonNullable<RollConfig["keep"]>;

const defaultEps = 0;

function configIn(config: RollConfig): Record<string, unknown> {
  return { ...config };
}

function pmfOf(handle: unknown): PMF {
  return PMF._wrapShared(handle as NativePmfHandle);
}

/** Empties the Rust die and expression caches (`singleDiePMFCache`, `d20RollLiftCache`, `builderPMFCache`). */
export function clearDieCaches(): void {
  native.clearCache("singleDie");
  native.clearCache("d20Lift");
}

export function dieNodeFromConfig(cfg: RollConfig): DieNode {
  return nodeFromJson(native.astDieNodeFromConfig(configIn(cfg)) as string) as DieNode;
}

export function perDieKeepReading(
  count: number,
  sides: number,
  keep: KeepSpec,
  synthesizedBestOf = false
): "dice" | "trials" {
  return native.astPerDieKeepReading(count, sides, { ...keep }, synthesizedBestOf) as "dice" | "trials";
}

export function astFromRollConfigs(configs: readonly RollConfig[]): ExpressionNode | undefined {
  if (!configs || configs.length === 0) return undefined;
  const json = native.astFromRollConfigsJson(configs.map(configIn)) as string | null | undefined;
  return json == null ? undefined : nodeFromJson(json);
}

export function resolve(node: ExpressionNode, eps: number = defaultEps): PMF {
  return pmfOf(native.astResolve(nodeToJson(node), eps));
}

export function pmfFromRollBuilder(rb: RollBuilder, eps: number = defaultEps): PMF {
  return pmfOf(native.astPmfFromRollBuilder(rb._handle, eps));
}

export function resolveD20Roll(die: DieNode, rollType: RollType | undefined): PMF {
  return pmfOf(native.astResolveD20Roll(nodeToJson(die), rollType));
}

export function resolveRootD20(check: RollBuilder): PMF {
  return pmfOf(native.astResolveRootD20(check._handle));
}

export function naturalDieConfig(check: RollBuilder): RollConfig | undefined {
  const config = native.astNaturalDieConfig(check._handle) as RollConfig | null | undefined;
  return config ?? undefined;
}

export function resolveSingleDie(die: DieNode, eps: number = defaultEps): PMF {
  return pmfOf(native.astResolveSingleDie(nodeToJson(die), eps));
}

export function rerollablePool(node: ExpressionNode): {
  groups: { die: DieNode; count: number; sign: 1 | -1 }[];
  flat: number;
} {
  return parseNative(native.astRerollablePool(nodeToJson(node)) as string);
}

export function findDie(node: ExpressionNode): DieNode | undefined {
  const json = native.astFindDie(nodeToJson(node)) as string | null | undefined;
  return json == null ? undefined : (nodeFromJson(json) as DieNode);
}

export function getTotalCount(node: KeepNode): number {
  return native.astTotalCount(nodeToJson(node)) as number;
}

export function getASTSignature(node: ExpressionNode): string {
  return native.astSignature(nodeToJson(node)) as string;
}
