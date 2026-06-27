# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Breaking

- **`PMF.toJSON()` now returns a plain object** (`{ bins, normalized, identifier }`)
  instead of a JSON string, following the standard `toJSON` contract. This means
  `JSON.stringify(pmf)` no longer double-encodes. If you relied on the old string
  return, call the new `PMF.toJSONString()` instead.
- **`DiceQuery.firstSuccessSplit()` is typed as `OutcomeType | OutcomeType[]`**
  (previously `string | string[]`). Only affects callers passing arbitrary strings;
  valid outcome labels are unchanged.

### Added

- **`DiceParseError`** — `parse()` now throws this typed error (a subclass of
  `Error`) instead of a plain `Error`. Existing `try/catch` and message checks keep
  working; you can now narrow with `instanceof DiceParseError` and read
  `error.expression` / `error.cause`.
- **`PMF.toJSONString()`** — returns the JSON string form (the previous
  `toJSON()` behavior).
- **`DiceQuery.stdev()`** — alias of `stddev()`, matching `PMF.stdev()`.

### Changed

- Removed the stale `package-lock.json` (the project uses Yarn 4) and dropped the
  unused `ts-node` / `tsconfig-paths` dev dependencies.
- Removed `console.error` calls from the parser so the library no longer writes to
  a consumer's console.
- Internal refactors with no behavioral change: deduplicated `Bin` clone/scale
  logic in `PMF`, removed dead code and impossible iterator branches, and tightened
  internal `any` usage.
