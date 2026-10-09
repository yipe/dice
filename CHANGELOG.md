# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Turn` evaluates the first `TurnSpec` v2 fields **: an attack whose source is a
  `ContextualSource` (rolled `under` the row context the turn state puts it in; Elven Accuracy's three
  dice upgrade only an advantage the state grants), conditions on `first-crit`, a condition's `landing`
  (`"damage"` over an attack row: a hit or crit that deals 0 lands nothing), the `vulnerability` effect
  (`until: "next-hit"`: the next attack that hits takes double damage; a miss leaves it), and
  `stateLimit` (default 16,384 states per step; more is `too-many-states`). The save
  side: save rows read `saveDisadvantage` and `savePenalty` effects (`end-of-turn`, or `next-save`,
  used up by the next save that reads it; `to` scopes them to save rows), and a condition's `save`
  (`{ dc, bonus, rollType? }` or `{ failChance(context) }`, one or several) is rolled in the target's
  state at the start of the row that tries it, with the option it fails least. Conditions: `{ condition, rule, until }` puts a `ConditionRule` on the target (attack rolls by
  range, saves and the grant's own save by ability); `until: "until-damaged"` ends it after the first
  later row that deals its creature damage (the row's own, a miss payload included, or a rider that
  lands there), leaving `rule.onEnd` for the rest of the turn; and `optional: true` conditions are
  taken as the engine takes them: with up to three, the subset with the highest mean (the full set
  first, so a tie keeps it); past three, each where the later attack rolls on its creature lean melee. New
  error codes: `unknown-range`, `unknown-ability`, `save-without-ability`. Creatures: `AttackOptions.target` aims a row at a creature (default `"target"`) and every effect
  lives on the creature its row was aimed at; a once-per-turn condition (`first-*`) is tried only on
  a landing with a later reader on that creature; `on: "start"` conditions are in force on their
  `target` before the first row. Riders: a payload per attack
  (`ContextualPayload`, doubled with a hit that used up a vulnerability), `any-crit` riders with a
  `max` (their first `max` crits; `Infinity` for every crit), `landing: "any"` (every outcome once the
  row happens, a miss included), `happens` (one coin for the turn), `joins` (the rider's dice roll in
  the row while it has a landing left, and it deals nothing beside it there), partners (a first-hit
  rider named in another's `of` opens its rows, `where`, to it), conditions that fire where a rider
  landed (`of: [rider id]`, `where`), and gated attacks (`AttackOptions.after`), which happen at
  their own place in the turn only where the earlier attack landed. `dealing` (a landing must deal a
  damage type, read from `ContextualSource.dealt` and `ContextualPayload.dealt`) is evaluated by its
  odds: every attack's and rider's marginal and `mean()` are exact, and the turn's joint `pmf` throws
  `dealing-joint-unsupported`. Nothing is `unsupported-until-0.17` any more: the
  code is gone.
- **`Turn.marginal(id)`**: one attack's or rider's own damage distribution in the turn. An attack's
  (or attack-shaped rider's) carries `whenHappens`, `occurs` and the odds of the d20 it rolls
  (`rollType`); a rider's carries its `landings` per attack (hit, crit, and the part doubled by a
  vulnerability, before `happens`) and `anyLanding`. Every marginal comes from one walk that carries
  mass alone (and a capped rider's damage as a plain array), cached per turn.
- **More readers**: `stepStats(id).live` has every effect's odds (`autoFail`, `saveDisadvantage`,
  `savePenalty`, `vulnerable` beside the 0.16 three) with the part each source accounts for
  (`sources`), and `stepStats(id).conditions` the odds each condition is attempted on the row and
  takes; `attemptProbability(id)` is a condition's expected number of attempts; `landings(id)` the
  ways riders land on an attack together; `peakStates` the most states the walk held. The 0.16
  fields keep their numbers bit for bit.
- **Conditions, fluently**: `@yipe/dice/dnd5e` (`blinded()`, `paralyzed()`, `prone()`, `restrained()`,
  `stunned()`, `unconscious()`, their `RULES`, and `contestLossChance({ attacker, defender })`);
  `condition(name, rule)`, `vulnerability().untilNextHit()`, `saveDisadvantage()` and `savePenalty(d4)`
  (`untilNextSave()` / `untilEndOfTurn()`), and `untilDamaged()` on a condition; `turn.atStart(effect)`,
  `onFirstCrit` (on the turn and attached) and `dc.onSaveFailure([damage, effect])`; trigger options
  `save` (an `ability(...)` DC check, or a list the target picks from), `dealing`, `target` and
  `optional`; and the row facts `melee()` / `ranged()`, `ability()`, `pinned()` and `alwaysFails()`.
  The guide's new section "Conditions: what the target has, and what it gets" and
  `yarn example conditions` run nine examples (Vex, Topple, Stunning Strike, both grapples, Knock Out,
  Frostbite, Path to the Grave, a Restrained start), each pinned to the brute-force oracle.
- **`AttackBuilder.mean()` and `SaveBuilder.mean()`**: the expected damage, read from the exact PMF, so
  `d20.plus(8).ac(16).onHit(d8.plus(4)).mean()` is 5.75 without going through `toQuery()`. This matches
  `Turn.mean()`. `CheckBuilder` requires it. `RollBuilder` has no `mean()`, because `ACBuilder` and
  `DCBuilder` would inherit it and return the raw to-hit total and the chance the save fails. Use
  `.pmf.mean()` on a plain roll.

### Changed

- **Probability readers (`stepStats`, `fireProbability`, `expectedApplications`) are computed without
  convolving damage**; results may differ from 0.16 in the last bits (≤ 1e-12 relative). Only `pmf`,
  `mean` and `toQuery` walk the joint distribution.

- **No 8-flag cap**: granted modifiers whose lives do not overlap share a bit of the walk state, and up to
  30 may be live at once (`too-many-states` past that, no longer `too-many-flags`). Turns that walked
  before walk the same states and return the same numbers bit for bit.
- **An unreachable `to` is a no-op**: an effect whose `to` names a row with no attack roll after the
  condition's first source (an earlier row, a save) is never read, instead of `unknown-id`. A `to` id
  the turn does not have is still `unknown-id`.
- **An explicit `of: []` never lands**: a rider or condition with an empty `of` watches nothing (fire
  probability 0, a zero marginal). An omitted `of` keeps its default; with no attack to default to, it is
  still `unknown-id`.

### Documentation

- **The README is now a feature tour**: what the library does, with runnable examples (attacks, saves,
  roll types, damage-dice options, GWM by AC, turns, grants, charts) and a dice-expression cheat sheet.
  The full grammar, rules reference, `Turn` reference and architecture overview moved to
  [`docs/guide.md`](docs/guide.md). The README's code examples were corrected: builder imports come from
  `@yipe/dice/builder`, an attack's DPR is `.mean()`, and a parsed `PMF` uses `.query()`.

### Fixed

- **`landing: "damage"` on a rider over attacks was ignored; it now requires damage dealt.** A hit or
  crit that deals 0 is no landing for it (it was before), as for a save.
- **A skipped attack no longer uses up a pending `next-attack` grant** (since 0.14.0, an attack with
  `chance < 1` spent a grant such as `advantage().untilNextAttack()` in the rounds where it did not happen,
  so the next attack that did happen lost it). With `chance: 0` the turn now equals the turn without the
  attack, and a pending grant reaches the next attack in the `1 - chance` share of rounds, as the 0.14.0
  entry and the `chance` doc promise. The walk cleared the `next-attack` flags a step reads on every draw,
  including the "did not happen" draw, which rolls nothing; that draw now leaves them alone. A turn with no
  `chance` below 1 is unchanged.

## [0.16.0] - 2026-09-30

### Added

- **A dice-match descriptor over groups of dice with the same faces.** `diceMatchInfo()` (and so a
  `dice-match` rider and `bounce()`) needed a payload with exactly one die group; `roll(1, d6).plus(roll(1, d6))`
  had no descriptor while `roll(2, d6)` did. Groups whose dice show the same faces with the same odds
  are now one pool (`roll(2, d8).plus(roll(1, d8))` is 3d8, on the hit and on the auto-doubled crit),
  and a group with no dice adds none. The descriptor is the one the single group would have given, bit
  for bit. Groups of different kinds (a different die, or the same die with another `minimum` or
  `reroll`) are still refused: which kind must match is not defined (`2d8 + 1d6`).
- **A dice-match descriptor over `rerollUpTo` pools.** An attack with `rerollDamageUpTo(k, { rolls })`, and a
  payload made by `rollBuilder.rerollUpTo(k, { rolls })`, now have a descriptor. The dice that match are
  the dice that land: those kept and the new rolls. Exact, checked against a brute force that lists every
  roll, tries every subset of dice to reroll and lists every fresh die (a chain of beams too). On a crit the
  dice double and the budget does not, so the crit branch is the doubled pool with the same budget. A pool
  too big to enumerate (more than 1e7 steps: a 9th-level Chromatic Orb crit, 22d8 rerolling 5, takes
  about 0.6 million and 40ms, and 44d8 rerolling 5 about 5 million) has no descriptor and says so. A budget of 0 reads the plain pool.
- **The policy is the damage policy.** The caster rerolls for the most damage, exactly as the damage PMF
  models it: the dice with the largest positive expected gain, and with `{ rolls: 2 }` the roll worth more
  after its own rerolls. The descriptor never models a caster who rerolls to make the dice match, which
  is a different play with a different damage PMF too. The two differ: `2d8` rerolling 1 matches on
  5/32 of its rolls when the caster plays for damage (a match of low dice is rerolled away, and a roll
  with no match and a die below the mean rerolls too), and on 15/64 when the caster plays for a match, the
  figure `calculateBounceOdds(2, 8, { rerollDamageDice: 1 })` gives.
- **`AttackBuilder.diceMatchRefusals()`** returns `{ hit, crit }`: why a branch has no descriptor, in a
  phrase ("the damage rolls dice of different kinds (d8 and d6), and which of them must match is not
  defined"), `null` for a branch that has one. A `dice-match` rider that names a source with no descriptor
  now carries the cause in its `no-dice-descriptor` error, where it used to list three shapes that might
  apply. `HasDiceMatchInfo` gains the same method as an optional member; a source without it keeps the
  generic message. `diceMatchInfo()` itself returns what it did.

### Changed

- **A pool of dice with a minimum above the die's faces has no descriptor.** `roll(3, d4.minimum(6))` shows
  6 on every die and so always matches, while the descriptor placed the collapsed faces on the die's own top
  face, keyed its damages wrong (12, not 18) and so read "never matches". It is refused now, with the cause.
  A lone die still has its empty descriptor. No other pool that had a descriptor changes: a differential over
  4000 random dice-match turns (bounce chains, riders, follow-on attacks, minimums, rerolls, channels,
  explicit and no crits) against 0.15.0 is identical bit for bit, and so are 1500 random `rerollUpTo`
  pools (`rerollUpTo`'s own PMF is untouched). A test pins 400 of those turns to the digests 0.15.0 gave.

## [0.15.0] - 2026-09-29

### Fixed

- **The root and `/builder` entries share one `PMF` class** (a PMF made by one entry failed
  `instanceof PMF` in the other, so `Turn` refused it as a source, rider or crit damage with
  `not-an-attack`). The build bundled each entry separately (`splitting: false`), so each carried
  its own copy of `PMF`, `Mixture`, the error classes and the caches. tsup now splits the shared
  modules into a chunk both entries import, in both the ESM and the CJS output. No export moved
  or vanished, and the PMF arithmetic is untouched. Because the module state is shared too, a
  cache toggle or `clearParserCache()` called through the root entry now reaches the code the
  `/builder` entry runs; it used to change only the root's own copy.
- **A `Turn` of about 20 attacks with riders threw `RangeError: Invalid string length`** (or ran out
  of memory). `convolve`, `add`, `addScaled`, `branch`, `mixN`, `scaleMass`, `mapDamage`,
  `filterOutcome` and the other derived-PMF methods built the result's `identifier` by embedding
  its operands' identifiers, so a walk that merges states doubled or tripled the string every
  step. A derived PMF now carries no name of its own: its `identifier` is `pmf#` and 16 hex digits
  of a hash of its content, computed the first time it is read (`toJSON` reads it). It never grows,
  and equal content reads the same however the PMF was built. A name given at construction (a
  parsed expression, `"zero"`, `"empty"`, `"missNone"`, a name passed to `new PMF`, a `fromJSON`
  round trip) is kept, and `normalize()` and `compact()` pass theirs on. A 34-attack turn with
  Sneak Attack, Divine Smite, Hunter's Mark and a reroll now walks.
- **`convolve` and `power` results depended on creation order and on the cache.** `convolve` put
  its operands in order by identifier, and identifiers of an unnamed PMF came from a global
  counter, so two equal PMFs created in a different order added the same float terms in a
  different order and could differ in the last bits. `convolve` now orders its operands by
  `fingerprint()` (their content) and walks each in ascending damage order, so its result is a
  function of the two PMFs' content, the epsilon and `raw` alone. `a.convolve(b)`, `b.convolve(a)`, a rebuilt PMF, a
  PMF whose map was built in another order and a recomputation after the cache evicted the entry
  all return the same bits. Where the content order differs from the identifier order 0.14.2 used,
  a result moves in its last bits (at most about 3e-15 relative on the turns and pools measured);
  where the two orders agree, the result is bit-for-bit what 0.14.2 returned.
- The `convolve` and `power` cache keys are the operands' `fingerprint()` alone (with `eps`,
  `raw` and the exponent); they no longer spell out the operands' identifiers. `power()` keys on
  the normalized base it computes from, so two equal unnormalized PMFs whose maps were built in
  opposite orders (their `mass()` differs in the last bit) never share a cached result.

### Added

- **`Mixture` is exported from `@yipe/dice/builder`** (the root already exported it), the same class
  as the root's.
- **`SaveBuilder.onSaveSuccess(...)`** (chain it after `onSaveFailure`): a success deals a payload of its
  own, where `saveHalf()` fixes it at `floor(failure / 2)`. It takes `DCBuilder.onSaveFailure`'s overloads
  (a number, a string, a `RollBuilder`, `(count, die)`, `(count, sides)`, either with a modifier), read the
  way the failure payload is. The success keeps the label `saveHalf`, whatever the payload rolls (a flat
  `0` included: `onSaveSuccess(0)` is not the plain save's `missNone`); `OutcomeType` has no other label
  for a success that deals damage. `saveHalf()` and `onSaveSuccess()` are one or the other, as
  `halfOnMiss()` and `onMiss()` are: the second throws (`saveHalf()` twice, or `onSaveSuccess()` twice,
  is fine, the second `onSaveSuccess` replacing the first). `resolve().saveSuccess` is the payload's PMF,
  and `onSaveSuccess(failure.half())` resolves bit for bit to `saveHalf()`. The `SaveBuilder`
  constructor's third argument now also accepts the success payload (a `RollBuilder`) beside
  `"normal"` and `"half"`.
- **`toExpression()` prints a success payload** as `save (payload)`, a clause the parser already reads:
  `(d20 + 5 DC 15) * (2d6) save (1d4)`. `parse()` of it gives the save's own distribution, bin by bin
  and label by label. A save with a success payload and no failure effect prints its failure as
  `* (0)`, so the payload is not lost. The strings of a plain and a `saveHalf()` save are unchanged.
- **The resolved-save cache key names the success payload**, so two saves that differ only there never
  share a PMF. A payload that opts out of caching (a parsed string, `half()`, a scale) keeps the save
  uncached, as a failure effect does.
- The README documents the `save (Y)` clause and the `saveHalf` label of a success that deals damage.
- **`rerollUpTo(k)`: reroll up to k dice once all are seen, keeping the new rolls** (Empowered Spell,
  Piercer). `roll(2, d6).rerollUpTo(1)` rerolls the die worth rerolling, mean 8.2361 (7.9722 when only the
  first die can keep the better of two). The play is optimal for expected damage: the up-to-k dice with the
  largest positive gain `mean - shown` reroll (for identical dice the lowest faces below the die's mean, a
  subtracted die when it shows high), across every die group of the roll, mixed dice included. Equal gains on
  different kinds of die go to the higher-mean kind, so the order of the groups never matters. A rerolled die
  is a fresh roll of the same die under its own `reroll` and `minimum`; a die showing its mean keeps its roll.
  A budget covering every die is the per-die must-use reroll (`roll(4, d6).rerollUpTo(4)` is
  `roll(4, d6).reroll(3)`); a budget of 0 is the plain roll. The distribution is exact: a DP over the faces
  by gain, after `keepHighestAll`'s, whose state is the dice not yet placed and the dice rerolled per kind
  (a pool of 17 dice in 5 kinds resolves in about a second). Returns a `RerollUpToRollBuilder`, a
  transformed roll: `plus()` adds outside the pool, `doubleDice()`/`scaleDice()` double the dice and keep
  the budget (a crit), and `toExpression()` throws (the string grammar has no spelling). The roll must be
  plain dice: a keep, `bestOf`, a roll type, `explode`, `explodePool`, or an already transformed, pooled or
  parsed roll throws.
- **`rerollUpTo(k, { rolls })`: Savage Attacker's best of several rolls with a reroll budget.** The pool is
  rolled `rolls` times, each roll is scored by its expected total after its own best rerolls, the best is
  kept, and only that roll is rerolled: `roll(2, d6).rerollUpTo(1, { rolls: 2 })` has mean 9.1971. It is
  not `rerollUpTo(1).maxOf(2)`, which rerolls every roll and keeps the highest final total. With a budget of 0
  it is `maxOf(rolls)`. Exact, and checked against a brute force that lists every roll and tries every reroll set.
  This models "choose the roll, then reroll a die in it". A player who may use the reroll before choosing
  which roll to keep does better (1d8: 6.469 against 6.156; 1d12: 9.479 against 8.993; 2d6: 9.302 against
  9.197); that order is not modelled.
- **`AttackBuilder.rerollDamageUpTo(k, { rolls })`**: the same for the attack's base payload only (the hit and
  an explicit `onCrit`; an auto crit doubles the dice and keeps the budget). `rolls` rolls the whole base payload
  again, and `plusSeparateDamage` channels are never rerolled by the budget. Applied after `rerollDamage`, `minimumDamageDie` and `onCrit`, so call order does not matter;
  repeating the same call is a no-op and a different budget throws. `toExpression()` throws and
  `diceMatchInfo()` returns no descriptor for such an attack.
- Existing behaviour is unchanged bit for bit: a digest of attack, pool, keep, reroll and turn PMFs taken on
  origin/main (after #20) still matches.
- **Probes: `Turn.observeAnyCrit(id, { of })`, `Turn.observe(probe)` and `TurnSpec.observe`** report
  P(at least one of `of` crit) through `fireProbability(id)` and add no damage. A row that cannot crit
  (a save, a flat payload) is skipped, so the default `of` works on a mixed turn, and a probe with no
  source that can crit reports 0. The probe is
  JSON-safe (`{ id?, on: "any-crit", of? }`, `id` defaulting to `probe 1`, `probe 2`, ...; `of` defaults
  like a condition's: every attack plus every attack-shaped `any-miss` / `first-miss` rider), and
  `Turn.probeIds` lists them. The value comes from the walk, so a `critOnHit` grant, a reroll, a
  substitute and an attack's `chance` are counted, and it equals the `fireProbability` of a
  zero-damage `onAnyCrit` rider over the same sources to 1e-12 (the only route before, at the cost of a
  rider slot). A probe keeps its source group live to the end of the walk, so it counts against
  `MAX_TRIGGER_GROUPS` for the whole turn and shares the group a rider over the same sources has. It
  shares the id space with attacks, riders, substitutes and conditions (`duplicate-id`), and no `of` can
  name it (`not-an-attack`). Any other `on` is `unsupported-trigger`. `vsAC` keeps a turn's probes.
  Adding a probe leaves `pmf`, every other id's `fireProbability` and `stepStats` exactly as they were:
  the damage walks the turn without its probes.
- **`fireProbability(probeId)` reads a walk that carries no damage distribution.** The states hold only
  the mass of the paths they stand for, so no PMF is convolved, added or scaled: a 7-attack turn with
  Sneak Attack, Hunter's Mark, a smite, a next-attack grant and a reroll reads a probe in about 0.3ms
  against 108ms for `mean()`. Any other id, `pmf`, `mean()`, `toQuery()` and `stepStats` still read the
  full walk, bit for bit as before, and a probe's value does not depend on whether the damage was
  resolved first. With a pruning `eps` above 0 a probe's masses ignore the pruned damage bins.
- **`landing: "fail" | "damage"` on a rider (`RiderOptions.landing`, `Rider.landing`)** lets a rider watch
  a save row. A save has no hit or crit, so a rider naming one was `not-an-attack`; with `landing` the
  rider reads the save's outcome: `"fail"` counts a failed save as a hit (its label alone, whatever
  it dealt), `"damage"` counts a failed save or a `saveHalf` pass that dealt damage above 0 (the "when
  you deal damage" reading), and everything else is a miss (so `first-miss` and `any-miss` fire on
  it). A save never crits. It applies to the save rows among the rider's `of` and is ignored for
  attack sources, which land on a hit or a crit as before. It works for every rider trigger except
  `not-fired` (which watches a rider, not attacks). Riders may read one save row under different kinds:
  the row's step draws four classes (failed with damage, failed for nothing, passed with damage,
  everything else) and each group of riders advances by the class its own kind lands, so a `"fail"` and
  a `"damage"` feature over one save are both exact. A save that cannot fail, or cannot pass, reads
  correctly. A save row's own `stepStats` do not depend on the riders that watch it. A
  grant, a transform or an unknown kind carrying `landing` throws `unsupported-trigger`. Without
  `landing` a save row is `not-an-attack` as before, and the message now says how to watch it. Only a
  declared save row can be watched, not a save that a rider carries as its damage.
- New types `ProbeSpec` and `SaveLanding`.
- **One rider model: `onFirstHit` applies once, `onEveryHit(damage, { max })` at most `max` times,
  `onEveryHit` every time.** `max` is also `{ on: "every-hit", of, max }` in a spec. The rider
  applies to at most `max` landings among `of`, in turn order, each in its own landing's mode (a
  crit doubles that application's dice): Superiority dice, "the first two hits". Exact, not a mean
  adjustment. Each attack a capped rider watches carries a with-rider and a without-rider draw set,
  and the walk picks between them while the rider's count of applications is below `max`; a hit or
  crit drawn from the with-rider set advances the count. Riders over the same sources with the same
  `max` share one count, and a count is dropped from the walk state as soon as the attacks still to
  come cannot reach the cap, so a cap at or above the number of attacks watched is folded exactly
  like an uncapped rider: `onEveryHit` bit for bit, with the same states.
  **`max: 1` is `onFirstHit`**: the plan lowers `{ on: "every-hit", max: 1 }` to a first-hit rider,
  so `otherwise`, `not-fired`, being named in another rider's `of` and the numbers are
  `onFirstHit`'s, bit for bit. A cap is a positive integer (`RangeError` otherwise), is refused on
  any other trigger (`unsupported-trigger`) and beside a grant (a grant is never capped). A capped
  rider that watches an `onAnyMiss` reroll is refused (`unsupported-trigger`, use `onFirstMiss`):
  that reroll resolves after every declared attack, so the cap would count its landing at the end
  of the turn. At most `MAX_CAPPED_COUNTERS` (6) riders with different caps of 2 or more or
  different sources may watch one attack (`too-many-counters`, a cost ceiling: the draws double
  with each).
- **`Turn.expectedApplications(id)` for any rider**: the expected number of times an `every-hit`
  rider applies (`E[min(landings, max)]` for a cap); for every other rider, which applies at most
  once, its `fireProbability`. `fireProbability(id)` of an every-hit rider is P(applied at least
  once), which is P(some watched attack landed). A substitute, a condition or an attack id is
  `unknown-id`.
- **A payload per landing source: `perSource`** on `onFirstHit` and `onEveryHit` (and the spec's
  `perSource` on `first-hit` and `every-hit` riders): source id to `{ damage, critDamage? }`, the
  payload dealt when that source lands, for a payload that depends on the landing row (its damage
  type, the target's scale for it). A source not listed deals the rider's own `damage`; each entry
  doubles its own dice on a crit unless it names its `critDamage`. A per-source first hit is one
  rider like any other (`fireProbability`, `otherwise`, `not-fired`), applied inside its sources'
  draws, so another rider cannot name it in `of`. A key the rider does not watch is `unknown-id`;
  the option is refused on any other trigger, beside a grant and beside a transform. A per-source
  first hit, or a capped or per-source every-hit rider, whose damage, `critDamage` or payload
  rolls its own attack is refused too (`unsupported-trigger`): those riders are folded into their attacks'
  draws, which skips grants, step statistics and the `critDamage` check. Declare that attack as a
  plain `onFirstHit` rider instead; a plain `onEveryHit` keeps folding whatever it rolls. It is typed
  on the two triggers that take it, so it does not compile elsewhere. A first-hit payload per source that watches an `onAnyMiss` reroll is
  refused like a cap.
- **Over a save row, a capped or per-source rider reads it under its `landing` kind**: a cap counts a
  save as a landing only where the kind says (`"fail"`: any failed save; `"damage"`: a failure or a
  `saveHalf` pass that dealt damage above 0), and a per-source first hit marks its fire slot the same
  way. Riders that differ only in their kind keep separate counts. A probe beside a capped rider
  reads the same walk and changes nothing else.
- New exports: `EveryHitOptions`, `FirstHitOptions`, `PerSource`, `RiderPayload`,
  `MAX_CAPPED_COUNTERS`; the error code `too-many-counters`.

Nothing that existed changes: turns without `max` or `perSource` walk the same states and return the
same numbers bit for bit (checked against 0.14.2 over every-hit turns beside first-hit, any-miss,
first-miss, dice-match, substitutes, granted modifiers and `chance` attacks).

### Changed

- **`convolve` is cheaper on labelled PMFs.** It lists each bin's labels once as a key array and a
  value array and sums from those with indexed loops, instead of destructuring an entry per label
  per pair. The sums are the same, in the same order, so the bits do not change. A `Turn` walk
  spends about a fifth less CPU (see the PR for timings).
- **`PMF.identifier` text.** It is now `pmf#<16 hex digits>` for a PMF built without a name (it
  used to read `anon#7`, `branch(…)`, `map(…)`, `a+b`, …). The constructor's `identifier` argument
  is optional, and the property is a getter. Nothing in the library reads it: cache keys and
  operand order come from `fingerprint()`. `toJSON()` and `toJSONString()` carry the new text.
- **`too-many-groups` counts trigger groups live at once, not source sets** (`bounce({ max })` with
  `max` past 9 threw, though every beam's group dies after its one reader). `MAX_TRIGGER_GROUPS`
  (still 9) was checked against the total number of distinct `of` sets a turn named. A group is
  now live from the first step that can advance it to the last step that reads it (to the end of
  the walk for an `every-hit` rider), and groups whose lives do not overlap share one slot of the
  walk's group codes, which is reset when its group dies. The cap is the peak number of slots, so a
  bounce chain of any length keeps two live, and a turn that rerolls or grants per attack no
  longer counts each attack's source set against the cap. A group nothing reads (a grant no later
  attack reads) takes no slot. No API change: every turn that fit the old cap walks to the same
  bits (checked against the release before it on 1800 random turns: distribution,
  `fireProbability`, `stepStats` and the walk's state counts all identical, 44 of them with a
  slot reused); a turn with more than 9 groups live at once still throws. A chain's state space
  grows linearly with its length: a 40-beam Chromatic Orb chain walks in about 2.4s.

## [0.14.2] - 2026-09-26

### Fixed

- **attribution chart keeps hits and crits that deal 0 damage** (they were dropped from the
  damage-0 bar, so the chart drew less than the full probability). `attributionByValue` credited
  the damage-0 bin only to `missNone`, by count, so a hit or crit that landed at 0 — a zero-damage
  attack, damage reduced to 0 by resistance or a negative modifier, an effect-only attack — lost
  its mass. The 0 bin now splits by count across every label present: `missNone` keeps its count
  share and a 0-damage hit or crit keeps its own, so every bin's drawn shares sum to its
  probability. For an ordinary PMF (hits always deal at least 1) the 0 bin holds only `missNone`,
  so nothing changes there.
- **attribution chart conserves mass when a source deals negative damage** (resistance or a
  negative modifier pushed a hit below 0, so a combined bin carried a negative `attr` beside
  positive ones). The damage-share split normalised by a total that included the negative
  contribution, then dropped the negative share, drawing more than the bin's probability. A bin
  whose `attr` holds any negative contribution now falls back to the count split, so every bin's
  drawn shares still sum to its probability.

## [0.14.1] - 2026-09-26

### Fixed

- **The attribution chart splits damage-bearing bins by damage share again** (0.14.0 split by
  outcome count, which labeled damage dealt by a hit as partly a Miss); mass is still conserved.
  `attributionByValue` now splits a damage-bearing bin by `attr` — the damage each outcome
  contributed — normalised over the labels actually drawn, so a guaranteed miss convolved with an
  always-10 hit draws 100% hit (not 50% missNone / 50% hit), and a crit 11 + hit 6 that sum to 17
  draw 11/17 crit / 6/17 hit (not 50/50). The mass leak 0.13.0 saw (0.69–0.77 drawn) is fixed at
  its source: `withAttribution` no longer fabricates `attr[missNone] = damage × count[missNone]` on
  a convolved bin — `missNone` is a clean miss, so it contributes 0 damage and is never attributed.
  Where a damage bin genuinely carries no usable `attr`, the split falls back to `count` (still
  excluding `missNone`), so no bin's mass is dropped. The clean-miss bin at 0 keeps crediting only
  `missNone`, by count.

## [0.14.0] - 2026-09-26

Occurrence probability on declared attacks, strict spec validation, and a chart fix that
restores mass conservation on convolved PMFs.

### Added

- **`attack({ source, chance })`** — a declared attack may happen with probability `chance`
  (in `[0, 1]`, default 1). With `1 − chance` probability it does not happen at all: it deals
  no damage, is **not** a miss for `any-miss` / `first-miss`, and is **not** a landing for a
  hit trigger — the turn proceeds as if the attack were never declared. It replaces gating a
  source's PMF in place (`PMF.applyHitFrequency`), which folded the skipped mass into the
  `missNone` outcome and let a skipped round spend a `next-attack` grant or fire a miss
  trigger. `chance: 1` is byte-identical to omitting it; `chance: 0` contributes nothing.
  Works through `Turn.from`, `turn().attack(source, { chance })`, `turn().attacks(n, source,
  { chance })`, `mean()`, `pmf`, `toQuery()`, `stepStats` and `fireProbability`, and is exact
  against a brute-force enumeration of occurrence × d20 outcomes, a `first-hit` and a
  `first-miss` rider included. `toQuery()`'s single is the occurrence-gated marginal, so
  `probAtLeastOne` and the chart stay consistent with the walk.

### Fixed

- **`damageAttributionChartModel` / `attributionByValue` now conserve mass on convolved PMFs.**
  The chart split a bin's probability mass by the `attr` (damage-mass) channel, which only
  matches the probability split within one bin of a single source. After `convolveMany`,
  `Turn.pmf`, a provided combined, or a frequency-gated row, one value arises from many
  `(a, b)` pairs with different damages, so a damage-mass split dropped the mass of every
  miss+hit pair — the chart drew 0.69 to 0.77 of the mass instead of 1. It now splits by the
  `count` channel (probability for a single source, expected count after convolution), which
  recovers `p` exactly per bin. Non-convolved splits are unchanged, and a conservation test
  covers each convolved kind.

### Changed

- **Strict spec validation.** `Turn.from` (and the attack builders) now throw a
  `TurnSpecError` on an unknown attack key (`unknown-key`; valid keys are `source`, `id`,
  `tag` and `chance`) and on a non-string id or tag (`non-string-id`), both of which 0.13.0
  silently accepted.

## [0.13.0] - 2026-09-24

Conditions can now be attached to the attack that grants them, and a turn reports per-step
statistics for every attack and attack-shaped rider.

### Added

- **`AttackBuilder.onEveryHit(grants, gate?)` / `AttackBuilder.onAnyCrit(grants, gate?)`** — carry
  a condition on the builder that emits it, instead of spelling the `of` on the turn. Every time the
  attack lands (`onEveryHit`) or crits (`onAnyCrit`), the grants apply to later attack rolls; a
  `{ save }` / `{ chance }` / `{ onSave }` gate matches the turn's trigger verbs. The receiver is
  unchanged and the result is a new, immutable builder, so `ss().onEveryHit(advantage().untilNextAttack())`
  leaves the plain `ss()` untouched. `turn(attacks)`, `Turn.from(spec)` and the chained
  `turn().attack(source)` all read each entry into one condition whose `of` is the carrying attack's
  id (id `"${slotId}:${index}"`), so a builder's condition travels through `vsAC` rebinding and
  `withCheck` re-derivation. Exact against the same d20 enumeration the turn-level verbs use:
  two `d20+8` vs AC 16 shortswords granting the next attack advantage, then a dagger, score
  19.2211; four in a row score 27.5867; a save-gated end-of-turn advantage on two staffs then a
  dagger scores 19.7207.
- **`Turn.stepStats(id)`** — per-step statistics for a declared attack or an attack-shaped rider:
  `rolled` (the mass in which the step drew at all — 1 for a declared attack, the fire mass for a
  rider), `hit` (P(landed, crit included)), `crit`, and `live.{ advantage, disadvantage, critOnHit }`
  (the mass in which each granted modifier was in force when the step read its flags, before it
  consumes anything). On a turn with no conditions `live.*` is 0 and `hit`/`crit` are the source's
  own probabilities; a damage-shaped rider, substitute, condition or unknown id is an `unknown-id`
  `TurnSpecError`. Three attacks where a hit grants the next attack advantage report, per swing,
  65.00 / 79.79 / 83.15% landed and 0 / 65.00 / 79.79% advantage.
- **Effects cookbook** in the README and `src/builder/example.ts`. It shows the fluent spelling of
  every combination of when (every hit, any crit, the turn's first hit), what (advantage,
  disadvantage, every hit is a crit), how long (next attack, rest of turn) and gate (chance, save,
  save with `onSave`). It also covers readers limited by tag, a condition already in force at the
  start of the turn, an attack that happens only some rounds, and `stepStats`. Every mean is pinned
  in `example.test.ts`.

### Changed

- **A bare `PMF` used as a source or payload is normalized to unit mass** before the turn is
  resolved, so `stepStats` and `fireProbability` are unconditional probabilities even when a caller
  supplies a PMF whose mass is not 1. Builder sources already had unit mass, so they are unaffected.
- **A rider whose source carries an attached condition throws `unsupported-trigger`.** Attached
  conditions are read only from declared attacks. Previously they were silently dropped on a rider.
- **`stepStats(id)` returns a copy**, so mutating the result cannot change a later read.

## [0.12.1] - 2026-09-24

Two string-parser fixes: `parse()` now agrees with the builder, bin for bin and label for label, on
an attack check that lands at a total of exactly 0 and on a trailing `+` after a payload that rolls 0.

### Fixed

- **An attack check that totals exactly 0 against an AC of 0 or less now lands.** The AC gate reads
  a miss as 0, so a landing at a total of 0 was lost with the misses: `(d20 - 5 AC 0) * (1d6)`
  missed on a natural 5, mean 2.8 (hit 0.7, missNone 0.25), where
  `d20.minus(5).ac(0).onHit(roll(1, d6))` means 2.975 (hit 0.75, crit 0.05, missNone 0.2). The gate
  now records its landings at 0, and the `*` payload, the crit (`crit`, `xcritN`, `xcrit0`),
  `&` mixes and the `miss`, `pc` and `save half` clauses treat them as hits, whether the 0 comes
  from a negative flat, a subtracted die or a bonus die: `(d20 - 20 AC 0) * (1d6)` crits on its
  natural 20 (mean 0 → 0.35), and `((d20 - 5 AC 0) & (d20 AC 10)) * (1d6)` goes from 2.45 to
  2.5375. An attack's miss clauses now also take its misses at 0 rather than its lowest total, which
  with a negative AC was a landed hit: `(d20 - 10 AC -5) * (1d6) crit (2d6) miss (1)` labelled a
  natural 5 `missDamage` (mean 2.675 → 3.175, missDamage 0.05 → 0.2). The check on its own labels
  a landed total of 0 `hit`. Saving throws (`DC`) were already exact.
- **A trailing `+` after an attack's payload now adds to a hit whose payload rolled 0.** The README
  says a term after the payload is part of it, but `+` adds only to a non-zero total, so it skipped
  the 0-damage hits: `(d20 + 5 AC 12) * (1d4 - 1) + 1d6` meant 3.23125, where
  `onHit(roll(1, d4).minus(1).plus(d6))` means 3.8 (its crit is `2d4 - 1 + 2d6`). The term is now
  added to every landed hit and crit, a landing at a total of 0 included, and to every other outcome
  that carries a payload (a `miss (…)` clause's damage, a potent-cantrip half, a save's failure or
  half), while a miss with no payload stays 0: `+ 3` goes from 2.7875 to 3.275,
  `crit (1d4 - 1) + 1d6` from 2.8875 to 3.5, `miss (1d4 - 1) + 3` from 5.85 to 6.075, and
  `(d20 DC 15) * (1d2 - 1) + 3` from 1.4 to 2.45, like `onSaveFailure(roll(1, 2).minus(1).plus(3))`.
  `*`, `**`, `/` and `//` after the payload act on its value as before, so a hit that deals 0 still
  deals 0.

## [0.12.0] - 2026-09-24

A once-per-turn damage-reroll substitution, a `first-miss` trigger that schedules a reroll where
the miss happened, conditions (advantage, disadvantage and crit-on-hit granted to later attack
rolls by earlier outcomes), a separate damage channel, half damage on a miss and check
re-derivation on `AttackBuilder`, crit doubling for every damage payload with dice, and `Turn` API
changes that turn silent wrong answers into errors.

### Added

- **`Turn.onFirstHit(keepBestDamage())`** — a once-per-turn payload transform: the first watched
  attack that lands rolls its base payload twice and keeps the better total. It reads the attack's
  own damage, so no dice are restated. On a crit it transforms the crit payload (already doubled).
  It never touches the miss branch, `plusSeparateDamage` channels or `every-hit` rider damage (the
  order is `maxOfTwo(base)`, then the channels, then the fold), and it allocates no trigger group.
  Exact: two `d20+5` vs AC 12 attacks for `1d4` match a brute-force enumeration of every die to
  `1e-12`. The default policy spends on the first landing, which is a lower bound on optimal play
  (15.9849 against the optimal 16.1889 on two `2d6+3` attacks). `fireProbability(id)` accepts
  substitute ids and reports P(spent); `substituteIds` lists them. Plain-data form:
  `TurnSpec.substitutes` (`SubstituteSpec`, kind `"reroll-keep-higher"`).
- **`keepBestDamage().ifBelow(threshold | { hit, crit })`** — spend only when the base payload
  total (dice plus the payload's own flat bonus, excluding separate-damage channels) is below the
  threshold for that mode; otherwise hold for the next watched attack. The threshold applies only
  while a later watched step can still land in the current turn state, so a landing spends when
  none can — on the last watched attack, and also earlier when a watched `first-miss` reroll can no
  longer fire. `ifBelow({ hit: 10, crit: 18 })` scores 16.188901 on the turn above. It compares the
  payload's own values, so it works on any payload, parsed strings and bare PMFs included.
  `.optimally()` is reserved and throws `unsupported-policy`.
- **`first-miss` trigger / `Turn.onFirstMiss`** — fires on the first watched attack that misses,
  and its step runs directly after that attack instead of after every declared attack, so a reroll
  lands in turn order for anything that reads order.
- **`Turn.vsAC(ac)`** — the same turn against another AC. Every attack with an AC, including
  attacks carried by riders, is rebuilt through `AttackBuilder.withCheck`; saves and bare PMFs pass
  through.
- **Declaration tags** — `attack(source, { id, tag })` and `attacks(n, source, { tag })`. An `of`
  entry that is not an id expands to every attack with that tag.
- `otherwise()` after a transform fires when the transform was never spent.
- **Conditions: `advantage()`, `disadvantage()`, `critOnHit()`** build a grant for later attack
  rolls; `.untilNextAttack()` or `.untilEndOfTurn()` gives it the lifetime a trigger verb requires,
  so `onEveryHit(advantage())` does not compile. `onEveryHit`, `onFirstHit` and `onAnyCrit` accept a
  grant, a list of grants, or grants mixed with damage in one list; `.to(ids or tags)` narrows which
  attack rolls read it (default: every later one, attack-shaped riders included). A grant resolves
  with the reading attack's own roll type by cancellation, a net advantage rolls
  `threeDiceAdvantage()`'s three dice when the attacker has it, and `critOnHit` makes every landing
  a crit. `{ chance }` or `{ save: d20.plus(2).dc(15) }` gates the grants — never damage in the
  same call — once per application: `onEveryHit` retries on each landing, `onFirstHit` tries once,
  and an application whose end-of-turn grants are already in force is skipped. `onSave` applies
  other grants on the success branch. Exact: two `d20+5` vs AC 12 attacks for `1d8+3` with "a hit
  gives the next attack advantage" score 12.202125 and match a brute force over the d20s to
  `1e-12`; three score 19.192196. `fireProbability(id)` accepts condition ids (P(the grants were
  applied where a later attack reads them)); `conditionIds` lists them. Plain-data form:
  `TurnSpec.conditions` (`ConditionSpec`, `GrantSpec`), which also accepts `first-miss` and
  `any-miss` triggers. A turn with no conditions walks exactly the states it did before.
- New `TurnSpecError` codes: `duplicate-substitute`, `attack-after-rider`,
  `no-rebindable-source` (also: a grant read by an attack with no check to re-derive),
  `unsupported-trigger` (also: a grant on any verb but those three), `unsupported-policy`,
  `too-many-flags` (more than 8 grants that a later attack reads).
- **`AttackBuilder.plusSeparateDamage(damage)`** — a second damage channel. It is added to the hit
  and crit payloads (its dice double on a crit, under an explicit `onCrit` too) but kept apart from
  the base payload, so `keepBestDamage()`, `rerollDamage` and `minimumDamageDie` never touch it and
  a `dice-match` trigger reads the base dice only. `onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6))`
  equals `onHit(roll(2, d6).plus(5).plus(2, d6))` bin for bin, hit and crit; several calls
  accumulate. `resolve()` exposes the two parts as `hitBase` / `critBase` and `hitSeparate` /
  `critSeparate`. `toExpression()` throws on an attack with a channel, because the string grammar
  has none and dropping it would change the numbers.
- **`AttackBuilder.rerollDamage(k)` and `minimumDamageDie(v)`** apply `reroll` / `minimum` to every
  die group of the base payload (the hit, and an explicit crit), never to the separate channels, so
  they read in any order: `onHit(roll(1, d8).plus(2, d6)).rerollDamage(1)` means 12.7708, not
  12.3333 (the last group only). `rerollDamage(k)` is a permission cap: each group rerolls at most
  `min(k, floor(sides / 2))`, so the result never falls as `k` grows. `rerollDamage(5)` on `2d6`
  means 8.5, like `reroll(3)`; `RollBuilder.reroll(5)` stays an obligation at 7.8333. Repeating
  either call with a different value throws (the same value is a no-op), and a payload with no dice
  descriptor (a parsed string) throws. An `onCrit()` set after either call gets the same transform,
  so call order does not matter.
- **`AttackBuilder.halfOnMiss()`** — a miss deals `floor(hit payload / 2)`: the base plus every
  separate channel, never the crit payload. The branch is labelled `missDamage`, so no trigger
  counts it as a landing and no substitution rerolls it. Combining it with `onMiss()`, in either
  order, throws. `toExpression()` throws on a `halfOnMiss()` attack; the grammar cannot express it.
- **`AttackBuilder.withCheck(fn)`** — the one way to re-derive an attack's hit, crit and miss odds.
  `fn` maps a `Check` (`roll`, `ac`, `critThreshold`, `rollType`, `advantageDice`, `critOnHit`) to a
  new one and the damage is kept: `withCheck(c => ({ ...c, rollType: "advantage" }))` equals
  building the attack with `withAdvantage()` before `.ac()`, bin for bin. `vsAC` and the condition
  variants are built on it. It throws on an attack with no AC to rebind.
  `ACBuilder.threeDiceAdvantage()` makes a net advantage roll three dice, whether the source has
  advantage itself or it is granted later (`d20+5` vs AC 12 with advantage lands 0.973, against
  0.91 with two dice), and matches `withElvenAccuracy()` bin for bin. `combine(rollType,
  advantageDice, flags)` resolves a roll type and granted flags by cancellation, and
  `ACBuilder.copy(ac)` takes a replacement AC.
- **`PMF.maxOfTwo()`** — the better of two independent draws. Each bin keeps its outcome labels and
  attribution, and the original mass is restored; on `2d6+3` it equals
  `roll(2, d6).plus(3).keepHighestAll(2, 1)` bin for bin.
- **A `no-discarded-builder` lint rule** (repository tooling, `config/eslint-no-discarded-builder.mjs`)
  flags an expression statement whose value is a `Turn`, `RollBuilder`, `AttackBuilder`, `ACBuilder`
  or `PMF`: an immutable builder call whose result is thrown away. `yarn lint` now covers `tests/`
  and `examples/` for this rule; the 34 existing discards were deliberate and are marked `void`.

### Changed

- **A chaining call's omitted `of` is snapshotted when the rider is added**: the attacks declared so
  far, plus any attack-shaped `any-miss` / `first-miss` rider declared so far (a reroll continues
  the attacks it watches). `dice-match` beams, `every-hit` riders and damage-shaped riders never
  join. `Turn.from(spec)` still resolves an omitted `of` to every declared attack.
- **`.attack()` / `.attacks()` after a rider or substitute whose `of` defaulted throws
  `attack-after-rider`** instead of silently leaving the new attack out. Give that rider an
  explicit `of` to opt out.
- `Attack`'s wrapper form is `{ id?, tag?, source }`; `id` is no longer required.
- A `dice-match` trigger on an attack with `plusSeparateDamage` splits the base payload by its
  match odds before the channel is added, instead of keying them on a total that includes it.
- A transform passed to any verb but `onFirstHit`, or as a rider's `damage`, throws
  `unsupported-trigger`.
- **Every damage payload with dice doubles them on a crit; flats never double.** A parsed string
  (`onHit("2d6+5")`, `d(...)`) no longer folds its crit into the hit: `ParsedRollBuilder.doubleDice()`
  / `scaleDice(n)` rewrite every dice term's count and keep the operators (`2d6 // 2` → `4d6 // 2`,
  `d6 reroll 1` → `2(d6 reroll 1)`), so `onHit("2d6+5")` crits bin for bin like
  `onHit(roll(2, d6).plus(5))`; a string containing an attack or save check (`AC`/`DC`) throws when
  used as a payload that doubles (`onHit`, `doubleDice()`); as a rider it is added as-is on a crit,
  like the attack or save builder it stands for. A pool doubles inside, then pools, on an attack, a
  `plusSeparateDamage` channel and a rider alike (see Fixed). A rider list doubles its builder parts
  and adds its bare `PMF` parts as-is (it used to leave the whole list undoubled).
- **An attack string with an `AC` check and no crit clause now crits** (it used to fold the natural
  20 into `hit`, so first-hit/every-hit riders never doubled and `any-crit` never fired):
  `"(d20 + 8 AC 16) * (2d6)"` labels its natural 20 `crit` with the hit dice doubled, like
  `d20.plus(8).ac(16).onHit(roll(2, d6))` (mean 4.55 → 4.9); a `crit (…)` clause still wins.
- **A term after an attack's payload is part of the payload.** The grammar reads left to right and
  `+` adds to non-zero totals only, so a term joined by `+`, `*`, `**`, `/` or `//` applies where the
  attack deals damage: its dice double on a crit, its flats do not, and the attack keeps its labels.
  `(d20 + 5 AC 15) * (1d8) + 1d6` means 4.8 (was 4.625, the 1d6 added to the crit undoubled), like
  `onHit(roll(1, d8).plus(roll(1, d6)))`; `(d20 + 5 AC 12) * (2d6) + 3` crits at 0.05 (was 0, so
  `any-crit` never fired and `first-hit` gave 1.75 instead of 15/8). After a `crit (…)` clause the
  term is added to the crit as written. The same holds unparenthesised (`d20 + 5 AC 15 * 1d8 + 3`).
- **A parsed check's crit is its natural roll at any bonus roll, with advantage, disadvantage,
  elven accuracy and halfling luck, for `crit` and `xcrit N` alike.** Closes the 0.3.0 / 0.10.0
  known limitation: the check's natural die is followed through every op, where it used to be
  peeled off the highest totals. `(d20 > d20 + 5 + 1d4 AC 15) * (2d6)` crits at 39/400 (was
  0.024375), `(hd20 + 5 + 1d4 AC 15) * (2d6)` at 21/400 (was 0.013125), and
  `(d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)` at 1/10 (was 0.0375), each like its builder.
  The natural die is the check's one d20 wherever it sits in the sum, even beside a larger die:
  `(1d4 + d20 + 5 AC 15) * (2d6) crit (4d6)` crits at 1/20 (was 0.0125), `(2d4 + d20 + 5 AC 15)`
  at 1/20 (was 0.003125), and `(d20 + d100 AC 60) * (1d6) crit (2d6)` at 61/2000 on the d20, mean
  7637/4000 as before; only a check with no d20 reads its largest die. Keep-spelled checks keep one
  natural roll: `2kh1d20`, `2kl1(1d20)` and `3kh1(1d20)` crit like `d20.withAdvantage()`,
  `withDisadvantage()` and `withElvenAccuracy()`. A max or min against another die or a number
  crits where the natural 20 is the value kept (`(d20 > d4 + 5 AC 10)` on every natural 20,
  `(d20 < 15 + 5 AC 10)` never, was 0.3). An `&` mix crits where one of its sides rolls its natural
  20, at that side's share, in either order and with the AC gate on either side:
  `(d4 & d20 AC 5) * (1d6) crit (2d6)` and `(d4 & (d20 AC 5)) * (1d6)` crit at 1/24, and
  `((d20 + 5) & (d20 + 3) AC 15)` at 1/20 (was 0.025). A die on the AC side is the target's roll,
  never the natural roll. A check with no single
  natural die (`2d20`, `d20 + d20`, `d20 + d20 + d100`, `2kh2(1d20)`, advantage over a total like
  `(d20 + 1d4)!`, `d20 + 5 > d20`, a reroll, repeat, keep or double advantage of a mix with a
  smaller die in it) now throws `crit rate cannot be computed exactly …` when
  it would crit, and an `xcrit N` wider than the die throws too (`d20 * 1d6 xcrit2 1d6` reads
  `xcrit21`). A check with no die at all
  (`(15 AC 12) * (1d6)`, `(25 AC d20) * (1d6)`) has no natural roll, so it never crits, as before,
  and a `crit (…)` or `xcrit N` clause on it is inert: `(15 AC 12) * (1d6) crit (2d6)` means 3.5
  (was 7, all crit), the mean of the `roll.flat(15).ac(12).onHit(d6)` that emits it.
- **A parsed attack still differs from the builder** where `parse()` has no natural-1 miss or
  natural-20 hit (`(d20+30 AC 5) * (1d8)` means 4.725, the builder 4.5); where the payload is one the
  doubling rewrite cannot read (`d4d6`, a nested check), which is added to the crit as-is; and where
  a term is joined by an op that also changes a miss (`~+`, `-`, `>`, `<`, `=`, `reroll`, `!`), a
  clause follows a trailing term, or a repeat wrapper `N(…)` surrounds the attack, all of which
  lose the crit and miss labels.
- **`&` shapes with no single reading now throw instead of returning a number that depends on
  operand order or spelling.** An `&` mix weights each side by its count of outcomes. With dice on
  either side inside a payload that doubles on a crit (`(d20 + 5 AC 15) * (1d6 & 3)`, a trailing
  `+ (1d4 & 2)`, `onHit("1d6 & 3")`, a rider's auto-crit, `doubleDice()`), doubling also moves each
  side's share (`2.0588803`, not `57/28`), so it throws `AmbiguousCritDoublingError`; a
  `crit (2d6 & 3)` clause still parses. An `&` with an attack already split into crit, miss or
  save outcomes (`((d20 AC 5) * (1d6)) & d4`), of a saving throw with a non-save
  (`d4 & (d20 DC 12)`), or followed by a crit, save, pc or miss clause throws too: each took its
  labels, and with a trailing term its mean, from its left side. A reroll, repeat, keep or double
  advantage of a mix with a smaller die in it throws when it would crit, so
  `(1(d20 & d4) AC 5) * (1d6) crit (2d6)` and `(2kh1(d20 & d4) AC 15) * (1d6) crit (2d6)`, exact
  in 0.11.0 (119/48 and 2093/1152), now throw; `((d20 & d4)! AC 15)` gives the second exactly.
- **Crits on keeps.** A keep-highest-of-1 payload, meaning "roll it N times, keep the best", doubles
  its dice inside each trial on a crit: `roll(2,d6).keepHighest(2,1).plus(3)` crits as
  `2kh1(4d6) + 3` (18.9334, the same as the pooled `keepHighestAll(2,1)`), and the parsed
  `2kh1(2d6)+3` as `2kh1(4d6)+3`. Other shapes have more than one reasonable doubled meaning, so
  `doubleDice()`/`scaleDice()` throws an Error that names the shape and asks for an explicit crit: a
  per-die keep with K >= 2 (`roll(4,d6).keepHighest(4,3)`, which used to crit at 88.98); any
  keepLowest (`3kl1`, `2kl1`); a `bestOf()` that is a keep, or becomes one when doubled
  (`roll(4,d6).bestOf(3)`, `roll(2,d6).bestOf(3)`); a non-d20 die rolled with advantage,
  disadvantage or elven accuracy (`d6.withAdvantage()`, which used to crit at the hit's mean); a
  parsed `NkhK(...)` with K >= 2 or any `NklK(...)`, nested included (`4kh3d6`, `3kh2(2d6+1)`,
  `2kh1(4kh3(1d6))`); a parsed min of two dice terms (`d6 < d6`); and a parsed `&` mix with dice
  on either side (`1d6 & 3`). This covers an attack's
  auto-crit (`resolve()` and `toExpression()` throw), a rider's auto-crit, and an attack string with
  no crit clause (`(d20+5 AC 12) * (4kh3(1d6))` now fails to parse). Fix any of these with
  `onCrit(...)`, a rider's `critDamage`, a `crit (...)` clause, or `noCrit()`. The attack check's own
  d20 advantage is never doubled. `keepHighestAll`/`keepLowestAll` pools, which double inside and
  then pool as before, and a flat cap or floor like `2d6 < 9` or `3>d6` do not throw, and
  `diceMatchInfo()` reports a `null` crit descriptor for such an attack, its hit side unchanged.
- **Refusals instead of silent wrong numbers.** Each of these now throws a named error where it
  used to return a number: `explode()` with no cap or an infinite cap (it rolled a plain die);
  non-finite arguments to `plus`/`minus`, `reroll`, `minimum`, `bestOf`, the keeps, `maxOf` and
  `d()`; a per-die `keepHighest(T, K)`/`keepLowest(T, K)` on N > 1 dice with more than one reading
  (`AmbiguousKeepError`; keeping K of one die's T rolls, K of the group's own N dice, and the best or
  worst of T rolls of the whole group are unchanged); a parsed string used as a check
  (`d("d20+5").ac(15)`, `ParsedCheckError`; it dropped the +5); a check whose natural roll is more
  than one die (`roll(2, d20).ac(15)`, `d20 + d20`); `diceMatchInfo()`/`bounce()` on an exploding,
  advantaged or subtracted pool (`no-dice-descriptor`); a rider whose damage is a list of several
  attacks named in `of` (`not-an-attack`; such a rider never joins a default `of`); and an
  attack-shaped `onAnyMiss` reroll that reads or applies a granted modifier (`unsupported-trigger`;
  it resolved after the last attack with that attack's grants, so use `onFirstMiss`).
- **A roll type on a group of several dice rolls each die that way**: `roll(2, d6).withAdvantage()`
  is two advantaged d6 (161/18); it used to be one.
- **`roll(N, X)`, `plus(N, X)` and `minus(N, X)` are N independent copies of X** when X carries a
  keep, `bestOf()` or `explodePool()`: `roll(2, d6.keepHighest(2, 1))` is 161/18 (it multiplied the
  dice count and read as the best of two 2d6), and each copy of an `explodePool` keeps its own budget.
- **`turn()`, `Turn.from()` and `AttackBuilder.resolve()` default `eps` to 0**, like `toPMF()`, so
  every reachable damage value is kept: ten d20+10-vs-AC-12 attacks for 20d6 reach 2400, not 2060.
  `Mixture` prunes relative to its normalized mass, so tiny equal weights no longer throw.
- **`setCachingEnabled(false)` disables and empties every internal PMF cache**, not only the parse
  cache. Cached PMFs are frozen (`PMF.map` is a `ReadonlyMap`), so mutating a returned bin throws
  instead of poisoning later results, and `clearRollCache()` also clears the die caches.
- **`Turn.from(spec)` fills an omitted `of` like the chaining methods**: the declared attacks plus
  the attack-shaped `any-miss`/`first-miss` rerolls, so a persisted turn equals its chained spelling.
- **`parse()` accepts a unary minus** (`-3 + 1d6`, `1d6 + -3`, `1d6 - -3`, `-1d8 + 1d6`), and every
  unreadable string throws `DiceParseError` with a grammar message instead of an internal
  `TypeError`. Division by a divisor that can be 0 and a roll of a `d0` throw.
- **Inside a parsed check (left of `AC`/`DC`), `+` always adds.** Outside a check it still adds to
  non-zero totals only; a check total of exactly 0 no longer drops the next term
  (`d20 - 5 + 1d4 AC 1`).
- **A parsed save string labels every failed save `saveFail`**, like the builder (it used `hit`, and
  a failure that rolled 0 had no label). `SaveBuilder.resolve().check` uses `DCBuilder.toPMF()`
  polarity: success at 0, failure at 1.
- **A natural 20 always crits** on an `alwaysHits()` attack at any crit threshold, including
  `critOn(21)`, as on an AC check.
- `explodingPoolMatchProbability(weights, count, budget)` replaces `(pMax, faces, count, budget)`;
  `scaleDamage(factor, rounding, denominator)` takes an integer denominator for an exact ratio;
  `missChance()` is documented as the probability that at least one attack misses (its value is
  unchanged). New: `PMF.createCache()`, `PMF#freeze()`, `LRUCache` options
  `{ onInsert, followsCachingToggle }`.

### Fixed

- **A flat bonus added after a bonus die was counted twice.** `.plus(n)` stores `n` on the last
  group, so `d20.plus(d4).plus(5)` held the 5 on the d4, and attack, AC, DC and save resolution
  added it once through the d4 and again as the check's flat bonus: against AC 15 with `2d6` on a
  hit it resolved as `d20 + d4 + 10`, mean 6.7375 and miss 0.0875, where the check means
  203/40 = 5.075 and 13/40. `getBonusDiceConfigs()` now returns the bonus dice without their
  flats, so every ordering of the same terms resolves bin for bin the same, with advantage,
  disadvantage, elven accuracy, `critOn`, and `minus()` (`d20.minus(d4).plus(5)` for Bane). Only
  spellings with a flat after a bonus die change; `d20.plus(5).plus(d4)` was already exact.
- **A pooled roll's crit rolled the whole pool twice.** `PooledRollBuilder.scaleDice()` (and so
  `doubleDice()`) wrapped the whole pool as `2(…)`, so `roll(2, d6).plus(3).keepHighestAll(2, 1)`
  crit at 22.7438 on an attack's auto-crit and on a rider's crit. It now rebuilds the pool from its
  doubled pre-pool roll, so the trial count and the flats never multiply: it crits at 18.9334, the
  same as `roll(4, d6).plus(3).keepHighestAll(2, 1)`. Dice added after pooling double too.
- **A `miss`, `save` or `pc` clause after a crit shrank the crit's share.** `Dice.normalize`
  rescaled the faces but not the outcome counts, so the crit mass came out divided by the clause's
  normaliser (0.05 → 0.05/6). It now scales the counts with the faces.
- **A rider with an unknown `on` never fired.** It now throws `unsupported-trigger` when the turn is
  built.
- **A group of zero dice rolls nothing.** `roll(0, d6)`, `new RollBuilder(0).d6()` and
  `roll(2, d8).plus(0, d6)` resolved as one die (yipe/dice#12); only the group's flat is left now.
  In strings, `0d6`, `0(X)`, `(1d4 - 1)d6` and `nd6` at n = 0 are 0 with probability 1 instead of an
  empty, mass-0 distribution (`1d8 + 0d6` read as mass 0).
- **Subtracting a roll subtracts its own flat.** `roll(2, d6).minus(roll(1, d4).plus(2))` is 5/2
  (was 6.5), and `d20.plus(5).minus(roll(1, d4).plus(1)).ac(15)` hits at 13/40. Subtracting a
  negative roll adds it (`roll(2, d6).minus(roll(-1, 4))` = 2d6 + d4).
- **A natural 20 always lands under crit-on-hit.** `alwaysCrits()` on an AC check, and every
  turn-level `critOnHit()` grant, treated the natural 20 as an ordinary roll, so granting
  crit-on-hit lowered the landing chance at an AC only a 20 reaches
  (`d20.plus(5).ac(26).alwaysCrits()` landed 0, exactly 1/20).
- **A builder check resolves from its natural roll exactly.** The natural roll is its d20 wherever it
  sits (`d4.plus(d20).plus(5).ac(15)` crit 0 → 1/20, mean 3.675 → 203/40), or its largest die with
  no d20; `withAdvantage()`/`withDisadvantage()`/`withElvenAccuracy()` after a bonus die apply to the
  d20, not the bonus die (5537/800, was 5.29375); a check with no die (`flat(15).ac(12)`,
  `flat(10).dc(12)`) compares its flat total with the target and never crits, like `parse()`,
  instead of adding a phantom d20.
- **`half()`, `scaleResult()`, `maxOf()` and `sumRolls()` keep their transform under arithmetic**
  (`roll(2, d6).half().plus(1)` = 17/4, was 8), and `maxOf(n)` keeps the whole inner roll:
  `roll(2, d6).plus(3).maxOf(2)` = 7369/648 (was 8.3719, the +3 dropped).
- **`scaleResult(num, den, rounding)` rounds `v·num/den` exactly**: `roll(1, d20).plus(1)
.scaleResult(9, 7, "ceil")` is 76/5 (was 15.25).
- **`parse()`'s `reroll` weights each result by its probability**, so a reroll of a sum, max, min or
  floor is exact: `2d6 reroll 2` is 257/36 (was 3002/421), `(d20 > d20) reroll 1` 221713/16000 and
  `(d20 < d20) reroll 1` off by up to 0.0044 before. A single uniform die (`hd20`, `d20 reroll 1`) is
  unchanged. `reroll d0` is a no-op again.
- **`toExpression()` strings re-parse to the builder's own distribution.** A reroll, minimum,
  roll-type or scaled term after another term is parenthesised (`d20 + 5 + (d8 reroll 1)`, was read
  as a reroll of the whole sum); a term after a running total that can be 0 joins with `~+`; keep,
  `bestOf` and roll-type groups are never merged by count (`2kh1(1d6) + 2kh1(1d6)` printed as
  `2kh1(2d6)`); there is no leading unary minus (`0 - 1d8`); an attack always prints its crit clause
  (`noCrit()` prints `xcrit0 (<hit>)`, a clause that crits on no natural face, so the string keeps
  the builder's labels instead of 0.12's implicit doubled crit); and
  `alwaysCrits()`, `threeDiceAdvantage()` and `maxOf()` print what they compute. Across 10,200
  random builders every printed string that parses now matches the builder bin for bin, except for
  the documented natural-1/natural-20 difference.
- **`parse()` resolves keeps with an exact order-statistic DP**, so `4kh1(2d20)`, `6kh2(1d20)` and
  `9kh3(1d8)` no longer hit the old 1e6-outcome cap, and an attack whose payload is a keep with no
  dice (`* (3kl2(4))`) crits again.
- **`quantile()`, `percentiles()` and `snapshot().percentiles` land on the exact bin** when the CDF
  equals p (a d20's median is 10, was 11), and `quantile(1)` is the maximum.
- **`rerollDamage()`/`minimumDamageDie()` keep a payload's own higher `reroll`/`minimum`**, and the
  reroll cap accounts for the floor (`minimumDamageDie(4)` with `rerollDamage(4)` on 2d6 = 29/3).
- **A damage rider on `onDiceMatch` doubles its dice when a crit's dice matched**, like every other
  rider on a crit.
- **Bounce odds:** `calculateBounceOdds` with `rerollDamageDice` (Empowered Spell) is exact, choosing
  how many dice to reroll ((3, 8, 2) = 583/1024; with Elemental Adept (2, 4, 2) = 43/64);
  `explodingPoolMatchProbability` weights non-max faces by their real probability and lets a single
  die match its own explosion (1/64 for a d8); `jointSumAndMatch` emits no residue bins.
- **Cache keys:** `cacheKey()` keeps ±Infinity and NaN distinct, the keep-pool cache is keyed on exact
  probabilities (it rounded to six digits), and `fingerprint()` escapes label keys.
- **PMF algebra:** `Mixture` label counts are normalized by the total weight and are not shared with
  a built PMF; `applyHitFrequency` is exact Bernoulli thinning for any mass and sign; `maxOfTwo` keeps
  full precision in the tail (30d4's top bins were 0); `mapValues` keeps outcome counts and never
  prunes; `probAtLeastOne`/`expectedDamageFrom` count a repeated label once and `probExactlyK` is 0
  for k < 0; `PMF.variance()` of a PMF whose mass is not 1 is the conditional variance, matching
  `DiceQuery.variance()`; `power()` no longer relabels a shared cached result; an `LRUCache` with
  capacity ≤ 0 stores nothing.
- **A parsed attack labels a landed hit that deals 0 as `hit`** (and a 0-damage crit as `crit`),
  like the builder; it was `missNone`, so a first-hit rider on `(d20 + 5 AC 12) * (1d4 - 1)` fired
  0.5375 of the time instead of 0.7. `xcrit0 (Y)` parses on any check and never crits.
- **A cached PMF cannot be changed through its map**: `set`, `delete` and `clear` throw and `map`
  cannot be reassigned. `roll(1, d6).toPMF().map.set(…)` used to corrupt every later roll of a d6.
- **Builder arguments with no meaning throw, naming the argument**: `scaleResult()` with a
  non-finite numerator or denominator or a denominator of 0; `ac()`, `dc()`, `critOn()`,
  `minimumDamageDie()`, `rerollDamage()` and a `withCheck()` result with a non-finite value; and
  `roll(n, sides)`/`d(sides)` with negative or non-finite sides, which used to give 0.
- Smaller exactness fixes: `d6.minimum(6).explode(2)` resolves instead of throwing; save and DC PMFs
  carry no float-residue bins; `combine("elven accuracy", 2, …)` rolls three dice; `resolve().crit`
  includes the doubled `plusSeparateDamage` channels even when no roll can crit; repeats whose
  counts outgrow exact integers (`200d100`) resolve instead of returning mass 0.

## [0.11.0]

Native pool-wide exploding dice and a `dice-match` bounce trigger, for Sorcerous Burst and
Chromatic Orb respectively — both previously unmodeled, forcing dprcalc to fake them app-side
with a scalar-gate approximation (see the app repo's `applyBounceScalingToPMF`). Ground-truthed
against brute-force enumeration throughout; see `docs/superpowers/specs/2026-09-21-native-bounce-and-explode-design.md`
in the app repo for the full derivation.

### Added

- **`RollBuilder.explodePool(budget)`** — a pool-wide exploding-dice budget: at most `budget`
  extra dice total across the whole pool, as opposed to `explode(k)`'s per-die cap (`n` dice each
  individually allowed `k` extra dice). Resolved as one DP over `(pending dice, budget remaining)`
  in `builder/ast.ts` — exact, not a simulation. Mutually exclusive with `explode()` on the same
  config; throws on a pooled roll and from `toExpression()` (the string grammar has no syntax for
  either exploding-dice mechanic). `2d8.explodePool(1)` has mean 10.0546875 — genuinely different
  from `2d8.explode(1)`'s per-die 10.125, the discriminating oracle a realized-size-i.i.d.
  approximation gets wrong.
- **`{ on: "dice-match" }` `Turn` trigger** — fires when a named source's own damage dice showed a
  duplicate value on hit or crit (Chromatic Orb's bounce). Exact joint `P(sum ∧ match)` via an
  elementary-symmetric DP over faces (`common/bounce.ts`'s `jointSumAndMatch`), composed correctly
  with a pool-wide exploding budget when both apply (`explodingPoolMatchProbability` — conditions
  on `(m, k)` = dice showing max/non-max rather than applying the plain formula to a realized pool
  size, which is measurably wrong: `0.179688` exact vs `0.176270` for 2d8 budget 1). The crit
  branch matches against the REAL doubled pool (fixing a same-class bug the app had lived with:
  crit-doubled dice were never checked for a match), with `keep()`/`bestOf()` pools and
  string-parsed sources correctly rejected as `TurnSpecError("no-dice-descriptor", …)` rather than
  silently guessing. `AttackBuilder.diceMatchInfo()` is the new capability surface
  (`HasDiceMatchInfo` in `common/types.ts`) that makes this possible without threading builder
  internals through the (deliberately builder-decoupled) `turn/` layer.
- **`bounce({ source, max })`** — sugar for a depth-capped chain of attack-shaped `dice-match`
  riders, so no caller hand-writes the chain. `max` is required (match probability alone does not
  terminate the recursion).
- **`PMF.splitByFactor(factor)`** — splits a PMF into two complementary PMFs by an arbitrary
  per-damage-value factor in `[0, 1]`, preserving `count`/`attr` attribution proportionally in
  each half (the same scaling `applyHitFrequency` uses). The primitive `dice-match` slicing is
  built on.

### Fixed

- **`MAX_TRIGGER_GROUPS` raised 4 → 9**, to cover Chromatic Orb's full upcast range (a 9th-level
  slot needs up to 9 additional bounce beams). Raising it naively would have been a real
  performance cliff: a 9-deep `bounce()` chain took 1.86s to resolve, because a trigger group
  stayed in the walk's state-dedup key forever after its one reader consumed it, fragmenting the
  state space by the number of distinct stopping points in the chain rather than the number of
  live groups. Fixed by tracking each group's last reader step (`TurnPlan.groupLastReadStep`) and
  excluding a group from the merge key once nothing downstream can read it — a 9-deep chain now
  resolves in ~40ms, with bit-identical output.

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
