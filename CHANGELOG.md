# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0]

Correctness pass across the attack-resolution and expression-serialization paths, found by an
independent math review of the shipped 0.9.0 package (brute-force + Monte Carlo verification
against every number below). Several of these are silent wrong-number bugs, not crashes — read
the Breaking section if you have tests or saved output pinned to the old (wrong) values.

### Fixed

- **Attack resolution silently dropped `minimum`/`explode` on the to-hit d20.** `ACBuilder`,
  `AttackBuilder`, `AlwaysHitBuilder`, `AlwaysCritBuilder`, `DCBuilder`, and the save resolver all
  rebuilt the d20 from a 2-argument `(rollType, rerollOne)` summary instead of resolving the
  actual die, so a floored d20 (e.g. Clockwork Soul's Trance of Order, `minimum(10)`) was a
  complete no-op in the damage math — only the rendered expression string (`10>d20`) was correct.
  Measured: `+9` vs AC 18 with a floor of 10 gave DPR 7.55 instead of the correct 12.35 (should
  never miss). New shared `resolveRootD20`/`resolveD20Roll` (`src/builder/ast.ts`) resolve the
  real `DieNode` and lift by roll type on top of it.
- **Expanded crit range (`critOn`/Champion 19-20 etc.) credited a crit without checking AC.** A
  natural roll inside the expanded range but below `critThreshold`'s implied "always hits" case
  (only a true natural 20 auto-hits under RAW) still needs to beat AC. Measured: `critOn(19)` vs
  an AC only a natural 20 could reach gave 2x the correct DPR; `critOn(17)` gave 4x.
- **Exploding dice (`explode(k)`) lost ~14% of total probability mass and modeled the wrong
  chain.** `resolveSingleDie` rescaled the non-max branch a second time after it was already
  correctly proportioned (`d6.explode(1)` had mass 0.861, not 1), and modeled `k` additional
  explosions as exactly `k` extra dice instead of a chain capped at `k`. Both fixed; `d6.explode(1)`
  now has mass 1 and mean 4.0833 (was 3.667).
- **`RollBuilder.toExpression()` didn't round-trip through `parse()` for `reroll(k>=2)` or
  `keepHighest`/`keepLowest`.** `reroll(2)` rendered as chained `reroll 1 reroll 2` clauses, which
  the parser reads as two SEQUENTIAL reroll passes rather than "reroll faces 1-2 once" — now
  emits the grammar's set-based `reroll d{k}` form. `roll(N, dS).keepHighest(N, k)` rendered its
  inner die multiplied by the full count (`4kh3(4d6)` — "keep 3 of four 4d6 sums") instead of the
  per-die pool the builder actually computes (`4kh3(1d6)` — "keep 3 of four individual d6s"), a
  ~3.7x round-trip error.
- **Parser `crit` probability collapsed with bonus to-hit dice** (e.g. Bless, `d20 + 5 + 1d4`) —
  fixed for a flat (no advantage/disadvantage) base die with a plain `crit` clause: `d20 + 5 + 1d4
  AC 15 crit ...` now reports crit probability 0.05, not 0.0125. Scope: the parser now tracks a
  flat base die's natural-max contribution separately through its `+`/`-`/`AC` chain (see
  `parser.ts`'s "Track a flat ... base check die" comment) instead of peeling the combined
  expression's single highest total. `xcrit` (an expanded range) and advantage/disadvantage/elven
  accuracy on the base die remain a known limitation below — the builder API is unaffected by any
  of this and was always correct.
- **`minimum(k)` stored `k + 1`.** `minimum(1)` floored at 2, `minimum(2)` at 3, etc. Now stores
  the requested floor directly: `minimum(3)` floors at 3 (see Breaking).
- **`ScaleRollBuilder.toExpression()` (vulnerability/resistance scaling) emitted a broken
  round-trip.** `scaleResult(2)` rendered as `2 * (inner)`; `*` in this grammar is
  `conditionalApply` ("if nonzero, take the right side"), not multiplication — `**` is. The
  re-parsed expression silently dropped the ×2 entirely. Now emits `**`. It also always emitted
  floor division (`//`) regardless of the configured rounding mode, so `scaleResult(n, d, "ceil")`
  silently re-parsed with the wrong (floor) distribution; now emits `/` (ceil) for `"ceil"` and
  throws for `"round"`, which the grammar has no token for. A zero denominator is normalized to 1
  before rendering, matching the AST path.
- **`doubleDice()`/`scaleDice()` silently stripped `Half`/`Scale`/`MaxOf`/composite-sum
  wrappers**, since none of them overrode `scaleDice()` and the base implementation resolves
  through `create()`, which downgrades to a plain `RollBuilder`. A resisted/vulnerable/composite
  hit payload's automatic crit-doubling (`hitEffect.copy().doubleDice()`) silently lost its
  resistance/vulnerability/mixed-type structure. All four wrapper classes now override
  `scaleDice()` to preserve their own transform.
- **`bestOf(k)` ("roll N, keep the highest k") was ignored by every PMF path**, and its
  `toExpression()` output did not round-trip. `astFromRollConfigs` never read `cfg.bestOf`, so the
  PMF was plain `NdS`; `toExpression()` rendered `NdSkh{k}`, a postfix form `parseKeep` cannot
  parse (`Expected Dice after keep modifier`). Now folded into the same keep-DP machinery
  `keepHighest()` uses, serialized as the parseable prefix form `NkhK(1dS)`, and — for `k === 1` —
  no longer mis-synthesized as "max of N sums of N dice" instead of "max of N individual dice"
  (`bestOf(1)` on `4d6` is `max(d6, d6, d6, d6)`, not `max(4d6, 4d6, 4d6, 4d6)`).
- **`PMF.power()`'s cache key was content-blind**, both at the `power()` layer (identifier only,
  unlike `convolve()`'s fingerprinted key — `X.mapDamage(f).power(n)` and `X.mapDamage(g).power(n)`
  could collide since `mapDamage` keeps the parent's identifier regardless of the mapping
  function) and inside `fingerprint()` itself, which only hashed mass, bin count, and the sum of
  bin values — two `mapDamage` variants sharing that identifier could also share every one of
  those three numbers while differing in per-bin probabilities. `power()` now includes
  `fingerprint()`, and `fingerprint()` now hashes every bin's probability plus its `count`/`attr`
  labels (`convolve()` preserves both) and the `normalized` flag.
- **`PMF.quantile()` ignored total mass**, comparing a raw running probability sum against `p`
  instead of `p * mass()` — a sub-unit-mass PMF (e.g. after `scaleMass()`) returned `max()` for
  any `p` the raw sum couldn't reach, instead of the true quantile. `DiceQuery.percentiles()` was
  unaffected (it normalizes independently).

### Breaking

- **`RollBuilder.minimum(k)` now floors at `k`, not `k + 1`.** Any code (or saved expression
  string) built against the old off-by-one must add 1 to its argument to keep the same floor:
  `minimum(1)` → `minimum(2)` for a floor of 2, etc.
- **`RollBuilder.toExpression()` output changed** for `reroll(k >= 2)`, `keepHighest`/`keepLowest`
  where the die count equals the trial count, `bestOf(k)`, and `scaleResult`/vulnerability
  scaling. All were previously wrong (or, for `bestOf`, unparseable) round-trips (see Fixed) —
  any code diffing/pinning the exact string needs updating, not just re-parsing.
- **`toExpression()` on an exploding die (`explode(k) > 0`) now throws** instead of silently
  rendering a plain (non-exploding) die that re-parses to a materially different distribution.
  The string grammar has no explode syntax; use the builder's own `.toPMF()`/`.pmf` instead of
  round-tripping through `toExpression()`/`parse()` for an exploding roll.

## [0.9.0]

Adds `Turn`: attacks plus conditional damage riders, resolved to one exact joint
distribution. This is the roadmap's `Turn` / `DamageRider` item.

### Added

- **`turn()` / `Turn`** (`@yipe/dice/builder`). Declare attacks, then chain riders
  in the same `onX` vocabulary the builders already use: `onFirstHit` (Sneak
  Attack), `onAnyCrit` (Divine Smite), `onAnyMiss` (Unerring Accuracy, Lucky),
  `onEveryHit` (Hunter's Mark, Hex, Rage), and `otherwise` for the branch where
  the preceding rider did not fire ("flurry of blows if I didn't smite").

  ```ts
  const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
  const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));

  const rogue = turn([dagger, dagger]).onFirstHit(roll(3, d6));
  rogue.mean();     // 18.6225
  rogue.pmf.pAt(0); // 0.1225

  const goliath = turn([dagger, dagger])
    .onFirstHit(roll(3, d6))
    .onAnyCrit(roll(2, d8), { id: "smite" })
    .otherwise([unarmed, unarmed])
    .onEveryHit(d6);
  ```

  Each method takes an optional `{ id, of, critDamage }`, where `of` selects which
  attacks the rider watches and defaults to all of them. All of them are sugar
  over `rider({ damage, on, of })`, which takes the trigger as plain data.

  Motivation: the pattern the README used to recommend — build a rider PMF with
  `firstSuccessSplit` + `PMF.exclusive`, then convolve it alongside the attacks —
  is only correct in the mean. A rider is perfectly correlated with the attacks
  that trigger it, so treating it as an independent single corrupts the
  distribution. For two `d20+8 AC 16 → 1d4+4` daggers plus `3d6` Sneak Attack it
  reports P(0 damage) = 0.015 against a true 0.1225, and a standard deviation of
  7.18 against 8.89. Because the means agreed, DPR checks never caught it while
  every distribution chart and percentile was wrong. `Turn` owns the sources and
  walks the joint outcome space instead, carrying one packed byte of state per
  trigger group.

  Riders sharing a trigger resolve jointly, so Sneak Attack and Fire's Burn fire
  together or not at all, and a `not-fired` rider is the other branch of the same
  decision rather than an independent event — mutually exclusive riders can never
  both land. Riders may be attacks themselves, and may be sources for other riders.

- **`tryParse(expression)`** — `parse` without the throw, returning an empty PMF
  for junk. It also accepts a *signed* integer, which the grammar rejects:
  `parse("7")` already returns a delta, but `parse("-3")` throws, and a
  half-typed damage field is a bare signed number often enough to matter. Every
  consumer had written this try/catch; dprcalc's version fell back to
  `1d1 + (n - 1)`, which the parser then rejected for a negative `n`. This one
  builds the delta directly, and refuses values outside the safe-integer range
  rather than quietly rounding them.

- **`withRollType(expression, rollType)`** — rewrite an expression's attack rolls
  between flat / advantage / disadvantage / elven accuracy, leaving the damage,
  crit and miss clauses alone. Each `d20` is resolved against the nearest
  enclosing check, so nesting works and an expression with several attacks is
  fully converted: `AC` is an attack roll, `DC` is the target's saving throw,
  which the attacker's advantage does not affect. Saves and pure damage come back
  unchanged, so this is safe to map over a mixed list. A halfling-luck `h` prefix
  is preserved.

  dprcalc was doing this by round-tripping through its own `AttackModel` parser
  and re-serializing, 47 lines deep, because there was no way to say "same attack,
  with advantage" to the library.

- **`DiceQuery.outcomeStats(outcomes?)`** — per-outcome `atLeastOneProbability`,
  `allProbability` and `damageRange`, with the range summed over the singles that
  can produce the outcome rather than read off the combined PMF. `snapshot()`
  takes its range from the combined `count`, which the convolution accumulates as
  an expected count, so its `avg` is size-biased for two or more attacks (its own
  doc comment says so). `outcomeStats` is linear in the attack count by
  construction, and the two agree for a single attack.

- **`Turn.from(spec)`** for plain-data construction from
  `{ attacks: [{ id, source }], riders: [{ id, damage, on, of }] }`, validated up
  front with a typed `TurnSpecError.code` (`unknown-id`, `duplicate-id`,
  `self-reference`, `cycle`, `not-an-attack`, `too-many-groups`), so a consumer UI
  can map errors to field states rather than reimplementing the checks. `Trigger`
  is JSON-safe and meant to be persisted verbatim.

- **`Turn.toQuery()`**, named to match `RollBuilder`/`AttackBuilder`/`SaveBuilder`,
  alongside a `pmf` getter as those have. There is no `toPMF(eps)`: a turn's
  epsilon is fixed at construction, where its plan is validated and its sources
  resolved.

- **`Turn.attacks(count, source)`** for Extra Attack, mirroring `roll(count, die)`,
  so a Fighter's four swings do not have to be spelled out as
  `turn([sword, sword, sword, sword])`. `turn()` also takes a bare source now, so
  a one-attack turn needs no brackets.

- `TurnSpecError` code **`unused-crit-damage`**, for a `critDamage` passed to a
  rider that rolls its own attack. Such a rider crits on its own terms — Great
  Weapon Master's bonus swing does not deal doubled dice because the attack that
  triggered it crit — so there was nothing for the value to mean and it was
  being dropped in silence.

- **`Turn.attackIds` / `Turn.riderIds`** in declaration order, including the
  `attack 1` / `rider 2` defaults, so a caller can discover the names that `of`
  and `fireProbability` accept instead of having to have supplied them all.

- Every construction path — `Turn.from`, `attack()`, `rider()` and the `onX`
  methods — validates immediately, so a bad `of` throws at the call that
  introduced it rather than later at `pmf` access. Measured at 0.63ms for the
  six validations in the full goliath chain, with an unchanged 26-AC sweep.

- **`Turn.fireProbability(id)`** — P(a rider fired), which the walk already knows. For
  `every-hit` riders it reports P(at least one source hit).

- `examples/turn-examples.ts` and `yarn example turn`.

### Changed

- **`DiceQuery.combinedWithAttribution()` now honours an explicitly provided
  `combined` distribution** instead of re-convolving `singles`. A provided
  combined is not necessarily the independent product of the singles — a `Turn`'s
  is strictly narrower — and re-convolving discarded it, dropping every rider's
  damage from attribution charts. Queries that provide no combined are unaffected.

### Removed

- `examples/sneak-attack-examples.ts` (~800 lines, six hand-rolled variants of the
  same turn). It only existed because there was no primitive for conditional
  riders. Its state-machine variant is the ancestor of `Turn`'s walk, and its
  agreement checks are now `tests/turn-exactness.test.ts`, which compares `Turn`
  against a brute-force enumeration of every attack-outcome sequence.

## [0.8.1]

Extends the resolved-PMF cache to every builder kind, so no consumer has to
key its own cache by the AST-walking `toExpression()`.

### Changed

- **`RollBuilder.toPMF`, `DCBuilder.toPMF` and `SaveBuilder.toPMF` now cache their
  resolved PMFs**, joining `AttackBuilder` (0.8.0). All four key by a cheap
  serialization of their `RollConfig`s and return `null` — resolving uncached —
  whenever a transform's PMF is not captured by those configs, so a conservative
  miss is always preferred to a wrong hit.
  - `RollBuilder` reuses the `cacheKey()` that already existed for
    `AttackBuilder`'s benefit. Subclasses overriding `toPMF`
    (`Half`/`Scale`/`MaxOf`/`Composite`) return a `null` key and stay uncached.
  - `DCBuilder` gains a `cacheKey()` extending the base with the save DC.
  - `SaveBuilder` gains a `cacheKey()` over the check, the failure effect and the
    save outcome.

  Motivation: profiling a dprcalc DPR plan put `toExpression()` at ~18% of self
  time — the largest single cost — because only attacks had an internal cache, so
  the consumer keyed its own by the expression string. Save-based builds have no
  such fallback: removing that consumer cache without this change regressed a
  Swords Bard by 15% and an Evoker Wizard by 11%. With it, the consumer layer can
  be deleted outright (measured −1% to −4% across five character canaries).

### Added

- `clearRollCache()`, `clearDCCache()` and `clearSaveCache()` test/bench seams,
  mirroring `clearAttackCache()`.

## [0.8.0]

### Added

- **`AttackBuilder.toPMF` caches its resolved PMF**, keyed by a cheap
  serialization of the check + effect `RollConfig`s rather than the AST-walking
  `toExpression()`. A DPR sweep resolves the same attack thousands of times
  (~99.9% repeats measured in dprcalc). `clearAttackCache()` is the test seam.

## [0.7.0]

Moves the full stacked damage-attribution chart pipeline into the library, so
consumers own no dice-or-probability logic for that chart.

### Added

- **`PMF.damageAttributionChartModel(options?)`** (and a `DiceQuery` convenience)
  returns the complete numeric model for the stacked damage-attribution chart:
  bucket `labels`/`binRanges`, discovered `outcomes` in stack order, per-outcome
  per-bucket `series` (bar-height mass) and `shares` (conditional tooltip share,
  with an `epsilon` divide-by-~0 guard), per-bucket `totals`, reversed-convention
  CCDF `percentiles`, and the `mean`. Options: `maxBuckets` (coarsen wide
  distributions — split-first-then-bin, so sub-`binSize` damage is never folded
  into the miss credit), `stackOrder`, `epsilon`. Exported type
  `DamageAttributionChartModel`.

### Removed

- **BREAKING:** removed the superseded, unused `DiceQuery` chart-series methods
  `toAttributionChartSeries`, `toDamageAttributionChartSeries`, and
  `toOutcomeAttributionChartSeries`. Use `attributionByValue()` for the raw split
  or `damageAttributionChartModel()` for the full chart model.

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

- **Parser crit probability with bonus to-hit dice — narrowed, not fully closed.** Fixed in
  0.10.0 for the common case (a flat base die, plain `crit`, no advantage/disadvantage). Still
  wrong for `xcrit` (an expanded crit range needs its own AC check per natural face) and for
  advantage/disadvantage/elven accuracy on the base die (not a single additive `+`/`-` chain from
  one base die) — both fall back to the old peel-based approximation. **The builder API computes
  all of these correctly** — use `d20.plus(..).plus(bonusDie).ac(..).onCrit(..)`.
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
