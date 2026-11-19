export { DCBuilder } from "./roll";
export type { SampledDie } from "../../../../src/builder/sample";

import { native } from "../native";

/** Empties the Rust DC check cache. */
export function clearDCCache(): void {
  native.clearCache("dc");
}
