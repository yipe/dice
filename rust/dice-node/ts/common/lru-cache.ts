import { setCachingEnabled as setTsCachingEnabled } from "../../../../src/common/lru-cache";
import { native } from "../native";

export * from "../../../../src/common/lru-cache";

/**
 * `setCachingEnabled`: the TS flag (read by `LRUCache`) and the Rust one (the PMF, parse, builder,
 * attack, save and DC caches in `rust/dice/src/pmf/cache.rs`). Turning it off empties both.
 */
export function setCachingEnabled(enabled: boolean): void {
  setTsCachingEnabled(enabled);
  native.setCachingEnabled(enabled);
}
