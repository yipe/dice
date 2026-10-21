import type { RollConfig } from "./types";

/** The original serializer, kept as the fallback for any config the fast path does not recognize. */
export function jsonRollKey(configs: readonly RollConfig[]): string {
  // Non-finite numbers are kept distinct: JSON.stringify alone writes ±Infinity and NaN as null.
  return JSON.stringify(configs, (_key, value: unknown) =>
    typeof value === "number" && !Number.isFinite(value) ? `#${value}` : value
  );
}

const FIELDS = new Set([
  "count",
  "sides",
  "modifier",
  "reroll",
  "explode",
  "explodePoolBudget",
  "minimum",
  "bestOf",
  "keep",
  "rollType",
  "isSubtraction",
  "pinned",
]);
const KEEP_FIELDS = new Set(["total", "count", "mode"]);
const SAFE_WORD = /^[A-Za-z0-9_-]+$/;

/** Absent or undefined. Numbers print as `String(n)` (`NaN`, `Infinity`, `-Infinity` stay distinct; `-0` is `0`). */
const ABSENT = "_";

/** `undefined` when the value is not an absent-or-number. */
function num(v: unknown): string | undefined {
  if (v === undefined) return ABSENT;
  return typeof v === "number" ? String(v) : undefined;
}

function word(v: unknown): string | undefined {
  if (v === undefined) return ABSENT;
  // A quote prefix keeps a present string distinct from ABSENT.
  return typeof v === "string" && SAFE_WORD.test(v) ? `'${v}` : undefined;
}

function bool(v: unknown): string | undefined {
  if (v === undefined) return ABSENT;
  return typeof v === "boolean" ? (v ? "t" : "f") : undefined;
}

function hasOnly(o: object, allowed: ReadonlySet<string>): boolean {
  for (const k of Object.keys(o)) if (!allowed.has(k)) return false;
  return true;
}

function keepText(keep: unknown): string | undefined {
  if (keep === undefined) return ABSENT;
  if (typeof keep !== "object" || keep === null || !hasOnly(keep, KEEP_FIELDS)) return undefined;
  const k = keep as Record<string, unknown>;
  const parts = [num(k["total"]), num(k["count"]), word(k["mode"])];
  return parts.includes(undefined) ? undefined : `{${parts.join(";")}}`;
}

/**
 * A key that identifies a roll's config array by value, without `JSON.stringify`. Equal values give
 * equal keys and equal keys mean equal field values; own-key order is ignored. It never contains `*` or
 * `|` (only digits, letters, `_ - + . ; ' { } [ ]` and a leading `~`), and ends in `]` or is `~`, so it
 * embeds unambiguously in the `*`, `|` and `e<eps>` composites of the roll, attack and save caches. It starts
 * with `~`, which no JSON key does.
 * A config with a field or type it does not know falls back to {@link jsonRollKey}.
 */
export function rollConfigsKey(configs: readonly RollConfig[]): string {
  let key = "~";
  for (const config of configs) {
    if (typeof config !== "object" || config === null || !hasOnly(config, FIELDS)) return jsonRollKey(configs);
    const c = config as unknown as Record<string, unknown>;
    const parts = [
      num(c["count"]),
      num(c["sides"]),
      num(c["modifier"]),
      num(c["reroll"]),
      num(c["explode"]),
      num(c["explodePoolBudget"]),
      num(c["minimum"]),
      num(c["bestOf"]),
      keepText(c["keep"]),
      word(c["rollType"]),
      bool(c["isSubtraction"]),
      bool(c["pinned"]),
    ];
    if (parts.includes(undefined)) return jsonRollKey(configs);
    key += `[${parts.join(";")}]`;
  }
  return key;
}
