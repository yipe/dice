# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Fixed (mathematical correctness)

Found via a multi-agent correctness audit; every fix is verified against an
independent brute-force enumeration (see `tests/math-correctness.test.ts`).

- **`DiceQuery.probabilityOf(label)` over-counted.** It summed the full `bin.p`
  of every combined bin that merely *contained* a label, but bins hold multiple
  mutually-exclusive outcomes — so `probabilityOf('crit')` returned 0.49 where
  the true P(crit)=0.05. It now returns the correct Poisson-binomial marginal
  (= `probAtLeastOne`). `missChance()` is fixed by the same change.
- **`DiceQuery.probExactlyK([labels], k)` array-path** delegated to the buggy
  `probabilityOf`, disagreeing with the (correct) single-label string path; both
  now match the true binomial.
- **`DiceQuery.variance()/stddev()`** used the unstable `E[X²]−E[X]²` form and
  lost all precision under a large constant damage offset (`1d6 + 1e8` gave
  variance 2 instead of 35/12). Now uses the centered, additive-per-single form.
- **`DiceQuery.mean()/variance()`** now stay consistent with an explicitly
  supplied `combined` that diverges from `convolve(singles)`.
- **`PMF.convolve()` produced `NaN`** for a zero-mass operand (divide-by-zero in
  the mass rescale), silently poisoning `DiceQuery.combined`. A zero-mass
  convolution now correctly yields mass 0.
- **`probAtLeastOne` is now mass-invariant** (per-attack probability divided by
  the single's mass) and clamped to `[0,1]` (was returning `1.0000000002`).
- **`PMF.firstSuccessWeights`** throws on `pSpecial > pSuccess` instead of
  returning out-of-range probabilities.
- **Parser `hd6`/`hd20` (reroll-one)** used a weighted union giving
  `P(1)=1/(2s−1)`; now uses `reroll(1)` for the correct `P(1)=1/s²`. The parser
  `hd` distribution now matches the builder's `reroll(1)` exactly (the
  previously loosened tests are tightened).

### Known limitations (documented; recommend maintainer review)

These are real but require API/architecture decisions, so they are documented
and pinned by tests rather than changed blindly:

- **Parser crit probability with bonus to-hit dice is wrong.** With bonus dice in
  the to-hit (e.g. Bless, `d20 + 5 + 1d4`), the string parser collapses crit to
  `1/(20·∏bonusSides)` (and the DPR is off by a few %), because the natural-20
  slice can't be separated after the bonus dice are convolved. **The builder API
  computes it correctly** — use `d20.plus(..).plus(bonusDie).ac(..).onCrit(..)`.
- **Multi-attack conditional statistics are size-biased.** `snapshot()`,
  `damageStatsFrom()` (single label), `outcomeTotals()` and
  `outcomeDamageRanges()` aggregate the combined PMF's `count`, which is an
  *expected count* for N≥2 attacks — so probabilities can exceed 1 and the
  conditional `avg` is size-biased. They are correct for a single attack /
  aggregate PMF. Use `probAtLeastOne` / `probExactlyK` for per-attack marginals.
- **Parser save-for-half mislabels outcomes** for some odd/low constant-damage
  expressions (the `2·half ∈ hit` auto-detection heuristic false-negatives).
  Damage values and the overall mean are unaffected; only the `saveHalf` /
  `saveFail` / `hit` labels are mixed up.
- **`PMF.mixN`/`gate`/`branch` build O(2ⁿ) identifier strings**, which can blow up
  (multi-MB, eventual `RangeError`) for very deep (≈20+) gate chains. Prefer
  `PMF.exclusive`/`PMF.mix` for large mixtures.

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
