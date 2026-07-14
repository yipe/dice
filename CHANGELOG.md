# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0]

Toolchain release: migrates the build to **TypeScript 7.0** (the Go-native
compiler). No library API or runtime behavior changes — the compiler port is
behavior-preserving, and consumer type resolution is verified equivalent across
`node16`, `nodenext`, and `bundler`.

### Changed

- **Migrated to TypeScript 7.0.2** (native Go `tsc`). Type-checking and
  declaration emit are ~5× faster on this codebase.
- Declarations are now emitted by the native `tsc` (tsup handles JS bundling
  only; its `rollup-plugin-dts` path does not support the TS 7 compiler API). A
  small post-build step adds explicit `.js` extensions to relative specifiers so
  the output resolves under `node16`/`nodenext`/`bundler`. The published `.d.ts`
  changes from a single bundled file to a mirrored tree; **named exports and
  type resolution are unchanged**.
- Bumped the dev toolchain: Yarn 4.17.1, plus latest `@types/node`,
  `typescript-eslint`, `eslint`, `tsx`, and `vitest`. Added the
  `@typescript/typescript6` bridge so `typescript-eslint` (which does not yet
  support TS 7) continues to lint against the 6.0 API while `tsc` runs on 7.0.

## [0.5.0]

Pushes damage-attribution / provenance and D&D-probability logic that the
consuming app (dprcalc) had hand-rolled over PMF internals down into the
library, so the provenance model and dice math stay owned here, and adds a
**composable scale node** so a scaled/rounded sub-roll can nest inside a larger
damage payload (per-damage-type resistance / immunity / vulnerability). All
additive except the Elemental-Adept bounce fix noted below.

### Added

- **`RollBuilder.scaleResult(numerator, denominator = 1, rounding = 'floor')`** —
  wraps a builder in a composable `scale` AST node that scales its resolved PMF
  by `numerator / denominator` with the given rounding. Unlike the old
  `.half()` wrapper, a scaled builder composes: it survives `sumRolls(...)`
  instead of being dropped on a flat-config merge, so a per-type resisted or
  doubled sub-roll keeps its own scaling inside a larger hit/crit payload. The
  rendered expression reflects it — `denominator === 1 → "N * (child)"`,
  `numerator === 1 → "(child) // D"`, general → `"(child) * N // D"`. `.half()`
  is now `scaleResult(1, 2, 'floor')`.
- **`sumRolls(parts: RollBuilder[])`** — additive factory whose `toAST()` is an
  `add` node over each part's AST, letting scaled and plain children sit side by
  side without the flat `.plus()` merge collapsing them. `toExpression()` joins
  the parts with ` + ` and `toPMF()` convolves them.
- **`PMF.applyHitFrequency(frequency)`** — provenance-preserving mass
  redistribution for effects that only occur with some probability (conditional
  attacks, on-hit riders, sub-one AoE fractions): scales every hit bin (damage
  &gt; 0) by `frequency` and moves the freed mass into a `missNone` bin. Unlike a
  bare `scaleMass`/`mapDamage`, it scales per-label `count` **and** `attr`, so a
  frequency-scaled PMF still renders correctly in the damage-attribution charts.
  Replaces the app's hand-rolled `applyFrequencyToPMF`, which dropped `attr`.
- **`PMF.missNone(epsilon?)`** / **`MISS_NONE_OUTCOME`** — canonical "clean miss"
  delta (point mass at 0 tagged with the `missNone` `OutcomeType`, distinct from
  `PMF.zero`'s builder-side `miss` label), and the label as a single source of
  truth.
- **`PMF.hitProbability()` / `PMF.missProbability()`** — the `1 - P(0)` idiom
  (miss encoded at damage 0), centralized.
- **`PMF.rebin(maxBuckets)`** — coarsen a wide distribution into ≤ N contiguous
  equal-width buckets, aggregating `count`/`attr` provenance. For charting wide
  distributions, not DPR math.
- **`PMF.attributionByValue()` / `DiceQuery.attributionByValue()`** — split each
  damage value's probability mass across outcome labels (by `attr` for
  damage-bearing bins, by `count` for the clean-miss bin), returning per-label
  `value → mass` series. The provenance core of the stacked attribution chart.
- **`DiceQuery.countSinglesWith(label)`** — how many independent single PMFs can
  produce a given outcome label.
- **`ALL_OUTCOME_TYPES`**, **`OUTCOME_DISPLAY_ORDER`**, **`sortOutcomes()`** —
  canonical `OutcomeType` enumeration + stack / display orderings, replacing
  per-consumer outcome tables.
- **`critProbability(critRange, rollType)`** and **`RollType`** (now exported
  from the package root as well as `@yipe/dice/builder`) — advantage-aware
  P(crit) for a given crit window.
- **`calculateBounceOdds(diceCount, dieFaces, options?)`** and
  **`BounceOddsOptions`** — the "birthday problem" for bouncing damage dice
  (Chromatic Orb), honoring Elemental Adept and Empowered Spell. Moved out of the
  app; the base and Elemental-Adept cases are now computed **exactly** (verified
  against brute-force enumeration in `tests/bounce.test.ts`).

### Fixed

- **`calculateBounceOdds` Elemental Adept was approximate.** The former
  hand-derived adjustment factor drifted from the exact value by up to ~3.5%
  (e.g. 3×d8, min-roll 3: 0.4965 → 0.5313). The Elemental-Adept branch now uses
  an exact elementary-symmetric-polynomial computation. Consumers relying on the
  old numbers for bouncing spells with Elemental Adept will see small DPR shifts.
- **`calculateBounceOdds` Empowered Spell returned certainty when rerolling all
  dice.** When `rerollDamageDice >= diceCount` (no dice kept), the model claimed
  a guaranteed match (1.0) instead of treating the reroll as a second
  independent roll. It now correctly yields `1 - (1 - pMatch)^2` in that case
  (e.g. 3×d8 reroll-all: 1.0 → 0.5693).

## [0.3.0]

### Fixed (mathematical correctness)

Every fix is verified against an independent brute-force enumeration (see
`tests/math-correctness.test.ts`).

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
- **`DiceQuery.snapshot()` outcome probabilities** (`atLeastOneProbability`,
  `allProbability`) were aggregated as expected counts and could exceed 1 for
  multi-attack queries. They now use the correct Poisson-binomial marginals
  (P(≥1) and P(all)) and are always in [0,1]. (`damageRange.avg` remains a
  size-biased mean for N≥2 — see Known limitations.)
- **Parser save-for-half mislabeled outcomes** on odd/constant damage (e.g.
  `(d20 DC 15) * (3) save half`): the brittle "2×half ∈ hit" detection
  false-negatived, tagging the success mass as `saveFail` and the failure mass
  as `hit`. Detection is now deterministic (the presence of a save distribution),
  so `saveHalf`/`saveFail` are always labeled correctly.
- **`PMF.compact()` corrupted PMFs that shared bin objects.** It deleted
  sub-epsilon `count`/`attr` entries *in place* and reused that same bin
  reference in the compacted map. Because bins are shared by reference across
  PMFs (the `branch()` / `addScaled()` / `scaleMass()` fast paths can carry
  another PMF's bin objects), this silently mutated the source PMF — and the
  receiver's own bins. `compact()` now clones each surviving bin before pruning;
  the compacted result is unchanged.

### Security / hardening

- **Parser resource-exhaustion guards.** Adversarial expressions are rejected
  with a `DiceParseError` instead of exhausting CPU/memory: a die over 1,000,000
  faces, a dice count over 10,000, a keep whose `faces^count` enumeration would
  exceed 1,000,000 outcomes, and a binary operation whose `faces₁ × faces₂` work
  would exceed 100,000,000 face pairs. The last closes a gap the per-operand
  caps missed — two individually-legal large dice (e.g. `d100000 + d100000`,
  ~10¹⁰ operations) previously hung for tens of seconds. All legitimate
  expressions, including `d100000`, still parse.

### Known limitations (documented; recommend maintainer review)

These are real but require API/architecture decisions, so they are documented
and pinned by tests rather than changed blindly:

- **Parser crit probability with bonus to-hit dice is wrong.** With bonus dice in
  the to-hit (e.g. Bless, `d20 + 5 + 1d4`), the string parser collapses crit to
  `1/(20·∏bonusSides)` (and the DPR is off by a few %), because the natural-20
  slice can't be separated after the bonus dice are convolved. **The builder API
  computes it correctly** — use `d20.plus(..).plus(bonusDie).ac(..).onCrit(..)`.
- **Multi-attack conditional damage `avg` is size-biased.** The `avg` returned by
  `damageStatsFrom()` (single label), `outcomeDamageRanges()` and
  `snapshot().damageRange` aggregates the combined PMF's `count` (an *expected
  count* for N≥2 attacks), so it is the size-biased mean E[dmg·#label]/E[#label]
  rather than a clean conditional expectation. It is correct for a single attack.
  (The associated *probabilities* are now correct — see Fixed.)
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
- **`DiceQuery` count queries (`probExactlyK` / `probAtLeastK` / `probAtMostK`,
  array-label paths)** compute each attack's success probability and the binomial
  DP once instead of rebuilding a query per requested count (~3× on the looped
  variants).
- **`PMF.branch()` assembles its Bernoulli mixture in a single pass** rather than
  chaining two `addScaled` calls (which copied the failure branch's bins twice).
- **`keepSumPMF` packs its DP state into a single integer key** instead of a
  `"used|r"` string parsed on every transition.
- **`computeMaxOfPMF` walks the support once with a running CDF** for large pools,
  reducing the max-of computation from O(N²) to O(N).
- **`Dice.reroll()` uses a `Set` for membership** and **`Dice.binaryOp()` hoists
  the inner die's face list** out of its loop.

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
- `Dice.outcomeData` is typed `Partial<Record<OutcomeType, …>>` (dropping an
  unsound `as Record<…>` cast); `getFullOutcomeDistribution()`'s return type
  matches. Type-only change; runtime output is unchanged.
- Added a `yarn format` script (ESLint autofix).
