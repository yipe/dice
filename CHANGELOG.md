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
- **`PMF.hasAttribution()`** — O(1) check for whether a PMF already carries
  damage-attribution metadata.

### Performance

- **`DiceQuery.mean()` / `variance()` / `stddev()` use moment additivity**
  (`E[ΣX]=ΣE[X]`, `Var[ΣX]=ΣVar[X]`) computed directly from the single PMFs.
- **`DiceQuery.combined` is now built lazily** (on first access) instead of in
  the constructor. Combined with the above, a query used only for DPR / mean /
  variance never performs the N-way convolution — multi-attack stats-only
  queries are ~10000× faster (e.g. ~17 ms → ~0.001 ms for a heavy 4-attack
  expression). The materialized `combined` distribution is unchanged; mean and
  variance may differ from the previous convolution-based values by at most a
  few ULP (well within the library's tolerances).
- **`DiceQuery.combinedWithAttribution()` reuses `combined`** when every single
  already carries attribution (as parser-generated PMFs do), avoiding a
  redundant convolution pass. Result is bit-for-bit identical.
- **`PMF.convolve()` inner loop accumulates directly into destination bins**
  instead of allocating a temporary bin per term and merging — ~1.6× faster
  convolution (the cost of building the combined distribution for charts). The
  probability channel is bit-identical; per-label `count`/`attr` provenance may
  re-associate by at most a few ULP (≤1e-14 even at 16 attacks, ~100× below the
  eps pruning threshold).
- **Convolution cache-key fingerprint is memoized** on each (immutable) PMF
  instead of re-summing every bin key on every `convolve()` call — ~36% faster
  on warm cache hits. Bit-identical (`PMF.fingerprint()` returns the same string).
- **`Dice.calculateHitDistribution()` no longer clones outcome distributions per
  face** — it reads the stored maps once instead of `O(faces × outcomes)` clones,
  ~10% faster cold parsing of wide-support expressions. Bit-identical.
- **`DiceQuery.toStackedChartData()` drops a dead `O(N×L)` precomputation pass**
  whose result was discarded — ~2× faster. Bit-identical.
- Minor bit-identical cleanups on the parse path (`Dice.toPMF` iterates the
  internal face map directly; `multiplyDiceByDice` uses a `Map`).

  All of the above were verified bit-for-bit identical (probabilities, counts,
  means, variance) across the full expression corpus.

### Changed

- Removed the stale `package-lock.json` (the project uses Yarn 4) and dropped the
  unused `ts-node` / `tsconfig-paths` dev dependencies.
- Removed `console.error` calls from the parser so the library no longer writes to
  a consumer's console.
- Internal refactors with no behavioral change: deduplicated `Bin` clone/scale
  logic in `PMF`, removed dead code and impossible iterator branches, and tightened
  internal `any` usage.
