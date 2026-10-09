# @yipe/dice guide

The [README](../README.md) shows what the library can do. This guide is the reference: the full dice
expression grammar, the exact rules the engine follows, every `Turn` feature, and how the code is laid out.

- [Dice expression language](#dice-expression-language)
- [Rules reference](#rules-reference)
- [Turns: attacks and conditional damage](#turns-attacks-and-conditional-damage)
- [Conditions: what the target has, and what it gets](#conditions-what-the-target-has-and-what-it-gets)
- [Statistics and charts](#statistics-and-charts)
- [Architecture](#architecture)

## Dice expression language

Spaces are ignored and letters may be any case. Every binary operator has the **same precedence and
associates left to right**: `1d6 + 2 * 3` is `(1d6 + 2) * 3`. Parenthesise to group.

| Syntax | Meaning |
| --- | --- |
| `7`, `d6`, `3d6`, `hd20` | A number, a die, a sum of dice, a die whose 1 is rerolled once (halfling luck, `d20 reroll 1`). |
| `N(X)`, `(X)d6` | N independent copies of X, summed. The count may be rolled: `(1d4)d6`. A count of 0 is 0 (`0d6`, `(1d4 - 1)d6` has P(0) = 1/4); a count that can be negative throws. |
| `NkhK(X)`, `NklK(X)` | The sum of the K highest (lowest) of N independent copies of X, exact for any X: `4kh3d6`, `2kl1(1d20)`, `4kh1(2d20)`. `2kl1(2d6)` keeps the lower of two 2d6 *sums*. |
| `X + Y` | Adds Y where the total so far is not 0, so a miss (0) stays 0. After an attack's or a save's payload it adds to every outcome that carries a payload (a landed hit or crit, a miss clause's damage, a potent-cantrip half, a save's failure or half), one that deals 0 included: `(d20 + 5 AC 15) * (1d4 - 1) + 1d6`. Inside a check total (left of `AC`/`DC`) `+` always adds, so `d20 - 5 + 1d4 AC 1` adds the d4 on a natural 5 too. |
| `X ~+ Y` | Always adds. |
| `X - Y`, `-X` | Subtracts. A leading `-` negates the argument after it, repeat included: `-2d6` is `-(2d6)`, `1d6 + -3` is `1d6 - 3`, `-1d8 + 1d6` has mean -1. There is no unary `+`. |
| `X * Y` | Y where X is not 0, else 0: the hit gate of `(check) * (damage)`. |
| `X ** Y` | The product. |
| `X / Y`, `X // Y` | Division rounding up, rounding down (toward -∞). A divisor that can be 0 throws. |
| `X > Y`, `X < Y` | The max, the min: `d20 > d20` is advantage, `3>d6` a floor of 3. |
| `X!` | The max of two independent copies of X. |
| `X = Y` | 1 where X equals Y, else 0. |
| `X & Y` | A mix weighted by each side's count of outcomes (see [refused mix shapes](#refused-mix-shapes)). |
| `X reroll R` | Rolls X, and on a result in the face set R rolls X again and keeps the second roll. |
| `X AC T`, `X DC T` | An attack check (X where X ≥ T, else 0) and a saving throw (0 on a save, 1 on a failure). A total of exactly 0 that meets a T of 0 or less lands, though it reads 0 like a miss: `(d20 - 5 AC 0) * (1d6)` hits on a natural 5 and crits on a 20, like `d20.minus(5).ac(0).onHit(roll(1, d6))`. |
| `… crit (Y)`, `… xcritN (Y)`, `… miss (Y)`, `… save half`, `… save (Y)`, `… pc` | Outcome clauses after an attack's or a save's payload. `xcrit0 (Y)` never crits: every landing is a hit. `save half` deals the payload halved and rounded down on a success, `save (Y)` deals Y. |

**Rerolls.** `reroll N` rerolls the face N only; `reroll dN` rerolls every face from 1 to N; the
builder's `.reroll(N)` rerolls every face up to N, like `reroll dN`. On a d6 they differ from N = 2
on: `d6 reroll 2` is 15/4, `d6 reroll d2` and `d6.reroll(2)` are 25/6. `reroll d0` rerolls
nothing. A reroll applies to the whole value on its left, so `2d6 reroll 1` rerolls the *total*,
which is never 1 (mean 7); spell a per-die reroll as `2(d6 reroll 1)` (47/6), and several of them as
`1(d8 reroll 1) + 2(d6 reroll 1)` (613/48). Each result keeps its own probability, so a reroll of a
sum, a max or a floor is exact: `2d6 reroll 2` is 257/36, `(d20 > d20) reroll 1` is 221713/16000.
The reroll decides on the raw face and a minimum applies after: `3>(d6 reroll 1)` (what
`roll(1, d6).reroll(1).minimum(3)` prints) is 25/6.

**Labels.** An attack labels its outcomes `hit`, `crit`, `missNone` and `missDamage`. A save labels a
failed save `saveFail` (whatever the payload rolls, 0 included), a success that deals damage (`save half`,
`save (Y)`) `saveHalf`, and a success with neither clause `missNone`, like the builder's `onSaveFailure()`. A landed hit whose
payload deals 0 is still `hit` (a 0-damage crit is `crit`), like the builder, and so is an AC
check's landed total of exactly 0; only a miss is `missNone`.

A `d0` has no faces: it is only a face set (`reroll d0`); rolled on its own it throws, as does a
string the grammar cannot read, always as a `DiceParseError`.

### Error Handling

`parse()` throws a `DiceParseError` (a subclass of `Error`) for invalid input.
Narrow with `instanceof` and inspect the offending `expression`:

```ts
import { parse, DiceParseError } from "@yipe/dice";

try {
  parse("d6@3");
} catch (err) {
  if (err instanceof DiceParseError) {
    console.warn(`Bad dice expression: ${err.expression}`);
  }
}
```

For UI code that parses on every keystroke, `tryParse()` returns an empty PMF
instead of throwing, and also reads an integer with a leading `+`, which the
grammar rejects — a half-typed damage field is one for a keystroke or two:

```ts
import { tryParse } from "@yipe/dice";

tryParse("1d6 + 2").mean(); // 5.5
tryParse("+7").mean(); // 7   — a leading `+`, which the grammar rejects
tryParse("-3").mean(); // -3  — the same as parse("-3")
tryParse("0x10").mass(); // 0  — decimal only
tryParse("1d").mass(); // 0   — empty PMF
```

The failure value has **mass 0**, not a distribution, and convolving it collapses
the whole result to mass 0 — check `mass()` or skip empties when combining
several expressions. Where a bad expression should surface rather than be
absorbed, use `parse()` and handle `DiceParseError`.

### Roll Types

`withRollType()` rewrites an expression's attack roll, leaving the damage, crit
and miss clauses alone — the usual way to chart one attack across advantage
states:

```ts
import { withRollType } from "@yipe/dice";

const attack = "(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)";

withRollType(attack, "advantage"); // "(d20 > d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"
withRollType(attack, "elven accuracy"); // "(d20 > d20 > d20 + 8 AC 16) * ..."
```

Every attack roll is rewritten, so an expression holding several attacks is fully
converted, nesting and all. Each `d20` is resolved against the nearest enclosing
check: `AC` is an attack roll, while `DC` is the *target's* saving throw, which
the attacker's advantage does not affect. Saves therefore come back unchanged, as
does anything with no check at all, which makes this safe to map over a mixed
list. A halfling-luck `h` prefix is preserved.

## Rules reference

### Saving throws

**A save's success.** `onSaveFailure(x)` alone deals nothing on a success, `.saveHalf()` deals `x` halved and
rounded down, and `.onSaveSuccess(y)` deals `y`. `onSaveSuccess` takes `onSaveFailure`'s arguments (a number, a
string, a `RollBuilder`, `(count, die)`, `(count, sides)`, either with a modifier). `saveHalf()` and
`onSaveSuccess()` are one or the other, like `halfOnMiss()` and `onMiss()`: the second throws. A success that
deals damage is labelled `saveHalf` whatever it rolls,
0 included, so `onSaveSuccess(0)` is not the plain save's `missNone`. `toExpression()` spells the success as
`save (y)`, which `parse()` reads back to the same distribution:

```ts
d20.plus(5).dc(15).onSaveFailure(roll(2, d6)).onSaveSuccess(d4).toExpression();
// "(d20 + 5 DC 15) * (2d6) save (1d4)"
```

A success that halves before a scale, the way a vulnerable target halves a fireball's dice before
doubling them, is `onSaveSuccess(base.half().scaleResult(2))` beside `onSaveFailure(base.scaleResult(2))`.

### Crits

**Crits double the damage dice, never the flats.** An `onHit` payload with no `onCrit` override
crits with its dice doubled: `roll(2, d6).plus(5)` and the string `"2d6+5"` both crit as `4d6 + 5`.
A pool doubles inside, then pools — `roll(2, d6).plus(3).keepHighestAll(2, 1)` crits as
`roll(4, d6).plus(3).keepHighestAll(2, 1)` (mean 18.93), not as the whole pool rolled twice (22.74).
Rider damage doubles the same way; a bare `PMF` has no dice, so it is added as-is. `onCrit(...)` and
`noCrit()` stay explicit, and a damage string containing an attack or save check (`AC`/`DC`) throws
when used as a payload that doubles (`onHit`, `doubleDice()`); as a rider it is added as-is on a
crit, like the attack or save builder it stands for.
An attack string with no crit clause crits too: `"(d20 + 8 AC 16) * (2d6)"` rolls its natural 20 as
`4d6`, like `d20.plus(8).ac(16).onHit(roll(2, d6))`; a `crit (…)` clause still wins. A term after
the payload joined by `+`, `*`, `**`, `/` or `//` is part of the payload and never applies to a
miss (the grammar reads left to right). `+` adds to every landed hit and crit, and to every
other outcome that carries a payload (miss damage, a potent-cantrip half, a save's failure or half),
one whose payload rolled 0 included, like the builder's `plus`: `(d20 + 5 AC 12) * (1d4 - 1) + 1d6` is
`onHit(roll(1, d4).minus(1).plus(d6))` (mean 3.8). `*`, `**`, `/` and `//` act on the payload's
value, so a hit that deals 0 still deals 0. `(d20 + 5 AC 15) * (1d8) + 1d6` crits as `2d8 + 2d6`,
like `onHit(roll(1, d8).plus(roll(1, d6)))`, and keeps its hit, crit and miss labels. After a
`crit (…)` clause the term is added to the crit as written, and after a `miss (…)` clause to the
miss damage too. The crit rate reads the check's natural die, its one d20 wherever it sits in the
sum (with no d20, its largest die), through bonus to-hit dice, advantage (`d20 > d20`, `d20!`,
`2kh1d20`), disadvantage (`2kl1(1d20)`), elven accuracy (`3kh1(1d20)`) and halfling luck (`hd20`,
`d20 reroll 1`), for `crit` and `xcrit N` alike: `(d20 > d20 + 5 + 1d4 AC 15) * (2d6)` crits at
39/400, like `d20.withAdvantage().plus(5).plus(d4)`, `(1d4 + d20 + 5 AC 15)` crits on the d20, not
the d4, and `(d20 + d100 AC 60)` on the d20, not the d100 (61/2000). A max or min against another
die or a number crits where the natural 20 is the value kept: `(d20 > d4 + 5 AC 10)` on every
natural 20, `(d20 < 15 + 5 AC 10)` never. An `&` mix crits where one of its sides rolls its natural
20, at that side's share of the mix, in either order and with the AC gate on either side:
`(d4 & d20 AC 5) * (1d6) crit (2d6)` and `(d4 & (d20 AC 5)) * (1d6)` both crit at 1/24. A die on
the AC side is the target's roll, never the natural roll. A check with no single natural die
(`2d20`, `d20 + d20`, `d20 + d20 + d100`, `2kh2(1d20)`, advantage over a total like `(d20 + 1d4)!`,
`d20 + 5 > d20`, a reroll, repeat, keep or double advantage of a mix with a smaller die in it, like
`(d20 & d4) reroll 1`, `1(d20 & d4)`, `2kh1(d20 & d4)` or `(d20 & d4)!!`) throws `crit rate cannot
be computed exactly …` when it would crit, and so does an `xcrit N` wider than the die. A check with
no die at all (`(15 AC 12) * (1d6)`, `(25 AC d20) * (1d6)`) has no natural roll, so it never crits,
and a `crit (…)` or `xcrit N` clause on it is inert: `(15 AC 12) * (1d6) crit (2d6)` means 3.5, like
`roll.flat(15).ac(12).onHit(d6)`, which emits that string.

### Refused mix shapes

**`&` shapes that are refused.** An `&` mix weights each side by its count of outcomes, so these
shapes have no single reading and throw rather than return a number that depends on how they are
spelled:

- `&` with dice on either side inside a payload that doubles on a crit: an attack string with no
  crit clause (`(d20 + 5 AC 15) * (1d6 & 3)`, or a trailing `+ (1d4 & 2)`), `onHit("1d6 & 3")`, a
  rider's auto-crit and `doubleDice()`. Doubling the dice also changes each side's share of the
  mix (`1d6 & 3` → `2d6 & 3` moves the flat's share from 1/7 to 1/37), so this throws
  `AmbiguousCritDoublingError`. Give the crit explicitly: `… * (1d6 & 3) crit (2d6 & 3)` parses.
- `&` with an attack already split into crit, miss or save outcomes (`((d20 AC 5) * (1d6)) & d4`,
  `(d20 + 5 AC 15) * (1d6) & 3`), `&` of a saving throw with anything but another saving throw
  (`d4 & (d20 DC 12)`), and a crit, save, pc or miss clause right after an `&` mix
  (`(d20 + 5 AC 15) & (1d6) crit (2d6)`). Mix the checks before the payload instead:
  `((d20 AC 10) & (d20 AC 15)) * (1d6)`.
- A reroll, repeat, keep or double advantage of a mix with a smaller die in it, when it would crit
  (listed above). `(1(d20 & d4) AC 5) * (1d6) crit (2d6)` and `(2kh1(d20 & d4) AC 15) * (1d6) crit
  (2d6)` were exact in 0.11.0 (119/48 and 2093/1152) and now throw. Spell the second as
  `((d20 & d4)! AC 15)`, which gives the same exact value.

### Where `parse()` and the builder differ

A parsed attack still differs from the builder in these cases:

- `parse()` has no natural-1 miss and no natural-20 hit: `(d20+30 AC 5) * (1d8)` means 4.725, the
  builder 4.5.
- A payload the doubling rewrite cannot read (`d4d6`, a nested check) is added to the crit as-is;
  the builder's `onHit` throws.
- A term joined by an op that also changes a miss (`~+`, `-`, `>`, `<`, `=`, `reroll`, `!`) loses
  the attack's crit and miss labels, so riders never see its crit. So do a clause after a trailing
  term (`… * (2d6) + 3 miss (1d6)`) and a repeat wrapper around an attack string
  (`2((d20 + 5 AC 15) * (2d6))`). An `&` there throws (see above).

### Crits on keeps

**Crits on keeps.** A keep-highest-of-1 payload, meaning "roll it N times, keep the best", doubles
its dice inside each trial on a crit. For example, `roll(2,d6).keepHighest(2,1).plus(3)` crits as
`2kh1(4d6) + 3` (18.9334, the same as the pooled `keepHighestAll(2,1)`), and the parsed
`2kh1(2d6)+3` crits as `2kh1(4d6)+3`. Other shapes have more than one reasonable doubled meaning,
so `doubleDice()`/`scaleDice()` throws an Error rather than guessing. The throw names the shape and
asks for an explicit crit. The shapes that throw are: a per-die keep with K >= 2
(`roll(4,d6).keepHighest(4,3)`, which used to crit at 88.98); any keepLowest (`3kl1`, `2kl1`); a
`bestOf()` that is a keep, or becomes one when doubled (`roll(4,d6).bestOf(3)`,
`roll(2,d6).bestOf(3)`); a non-d20 die rolled with advantage, disadvantage or elven accuracy
(`d6.withAdvantage()`, which used to crit at the hit's mean); a parsed `NkhK(...)` with K >= 2 or
any `NklK(...)`, including when nested (`4kh3d6`, `3kh2(2d6+1)`, `2kh1(4kh3(1d6))`); a parsed
min of two dice terms (`d6 < d6`); and a parsed `&` mix with dice on either side (`1d6 & 3`). This
covers an attack's auto-crit (`resolve()` and `toExpression()` throw), a rider's auto-crit, and an
attack string with no crit clause
(`(d20+5 AC 12) * (4kh3(1d6))` now fails to parse). You can fix any of these with `onCrit(...)`, a
rider's `critDamage`, a `crit (...)` clause, or `noCrit()`. The attack check's own d20 advantage is
never doubled and is unaffected. Three things still do not throw: `keepHighestAll`/`keepLowestAll`
pools, which double inside and then pool as before; a flat cap or floor like `2d6 < 9` or `3>d6`;
and `diceMatchInfo()`, whose crit descriptor is `null` for such an attack (its hit side is unchanged).

### Builder semantics

**Builder semantics.** `roll(N, X)` is N independent copies of X, so `roll(2, d6.keepHighest(2, 1))`
is two best-of-two d6 (161/18), and a group of zero dice rolls nothing (`roll(0, d6).plus(3)` is 3).
A roll type applies to each die of its group: `roll(2, d6).withAdvantage()` is two advantaged d6.
`explode(k)` needs a finite cap k, sides must be finite and not negative (`roll(2, 0)` is no die),
`scaleResult()` needs a finite numerator and a non-zero finite denominator, and `ac()`, `dc()`,
`critOn()`, `minimumDamageDie()`, `rerollDamage()` and a `withCheck()` result need finite numbers;
each throws, naming the argument. Per-die keeps have one reading each: `roll(1, d).keepHighest(T, K)`
keeps K of T dice, `roll(N, d).keepHighest(N, K)` keeps K of the N dice, and
`roll(N, d).keepHighest(T, 1)` is the best of T rolls of the whole group (`keepLowest(T, 1)` with
T ≠ N the worst); any other keep on several dice throws `AmbiguousKeepError`, so use
`keepHighestAll`/`keepLowestAll` or a keep on one die. `minus(X)` subtracts X's flat along with its
dice. `half()`, `scaleResult()` and `maxOf()` keep their transform under `plus()`/`minus()`.
A check's natural roll is its d20 wherever it sits in the sum (with no d20, its largest die);
`withAdvantage()`/`withDisadvantage()`/`withElvenAccuracy()` apply to that d20 whatever the call
order; a natural roll of more than one die (`roll(2, d20).ac(15)`) throws; a check with no die
(`flat(15).ac(12)`) compares its total with the target and never crits; a natural 20 always crits,
including under `alwaysHits()` and `alwaysCrits()`. A parsed string cannot be a check
(`d("d20+5").ac(15)` throws `ParsedCheckError`); spell it with the builder or as a full attack string.
`rerollDamage(k)` rerolls a face when its kept value, after any `minimumDamageDie` floor, is below
a fresh die's expected value, and never lowers a payload's own `reroll` or `minimum`.

### Reroll up to k dice

**Reroll up to k dice.** `roll(2, d6).rerollUpTo(1)` sees both dice, rerolls the one worth
rerolling and keeps the new roll (Empowered Spell, Piercer): mean 8.2361, where letting only the
first die keep the better of two gives 7.9722. It rerolls the up-to-k dice with the largest
positive expected gain (for identical dice, the lowest faces below the die's mean; a subtracted die
when it shows high), across every die group of the roll, so it is the best play for the most
damage. A budget of every die is `reroll(f)` on each die, `f` the faces below its mean
(`roll(4, d6).rerollUpTo(4)` is `roll(4, d6).reroll(3)`). A rerolled die is a fresh roll under its own
`reroll`/`minimum`; equal gains on different kinds of die go to the higher-mean kind, so group order
never matters. On a crit the dice double and the budget does not
(`roll(2, d6).rerollUpTo(1).doubleDice()` is 4d6 with one reroll). The roll must be plain dice
(a keep, `bestOf`, roll type or explode throws), and the result has no string spelling
(`toExpression()` throws). `roll(2, d6).rerollUpTo(1, { rolls: 2 })` is Savage Attacker with the
reroll: roll the dice twice, keep the roll worth more after its own best rerolls, then reroll only
that one (9.1971). That is not `rerollUpTo(1).maxOf(2)`, which rerolls both rolls and keeps the higher
final total.
`rolls` models "choose the Savage roll, then Piercer rerolls a die in it". A player who may use the
reroll before choosing does better (1d8: 6.469 against 6.156; 1d12: 9.479 against 8.993; 2d6: 9.302
against 9.197), and that order is not modelled.
On an attack, `rerollDamageUpTo(k, { rolls })` does the same for the base payload only (hit, and an
explicit `onCrit`; a crit's auto-doubled dice reroll up to the same k), leaving
`plusSeparateDamage` channels alone, in any call order with `rerollDamage`, `minimumDamageDie` and
`onCrit`; `rolls` rolls the whole base payload again and the budget never reaches those channels.
`toExpression()` throws. A `dice-match` trigger reads the dice that land after the rerolls, with the caster
rerolling for the most damage as the PMF does (see `diceMatchInfo()`).

### Strings from builders

**Strings from builders.** `toExpression()` prints a string that `parse()` reads back to the
builder's own distribution: a term after the first is parenthesised when it is an expression of its
own, `~+` joins a term to a running total that can be 0, and an attack always carries its crit clause
(`noCrit()` prints `xcrit0 (<hit payload>)`, which crits on no natural face). Explode, pool-wide explode, `scaleResult(…, "round")`,
fractional scale factors, `plusSeparateDamage()`, `halfOnMiss()`, `rerollUpTo()` and `rerollDamageUpTo()` have no spelling and throw.
Strings have no natural-1 miss or natural-20 hit.

## Turns: attacks and conditional damage

Most of what makes 5e damage interesting is conditional: Sneak Attack needs *a* dagger to land,
Divine Smite wants a crit, a flurry of blows only happens if you didn't smite. A **`turn()`** is
attacks plus riders that fire based on what those attacks did.

```ts
import { turn, d20, d4, d6, roll } from "@yipe/dice/builder";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));

const rogue = turn([dagger, dagger]).onFirstHit(roll(3, d6));

rogue.mean();      // 18.6225
rogue.pmf.pAt(0);  // 0.1225 — chance the whole turn whiffs
```

That is the whole API for the common case. A `Turn` resolves the **exact joint distribution**: a
rider is correlated with the attacks that trigger it, so building one as a separate PMF and
convolving it in gets the right mean but the wrong shape — the example above would report a whiff
chance of 0.015 instead of 0.1225.

| method | fires | example |
|---|---|---|
| `onFirstHit` | once, on the first attack that lands — doubled if it crit | Sneak Attack |
| `onAnyCrit` | once, if any attack crit | Divine Smite |
| `onAnyMiss` | once, if any attack missed; runs after every attack | a reroll no grant reaches |
| `onFirstMiss` | once, on the first attack that missed; runs right after it | Unerring Accuracy, Lucky |
| `onEveryHit` | once per attack that lands; `{ max: n }` stops after the first `n` | Hunter's Mark, Hex, Rage; Superiority dice |
| `otherwise` | when the rider before it did *not* | flurry of blows if you didn't smite |

### Extra Attack

`attacks(count, source)` mirrors `roll(count, die)`, so the Fighter's four — or eight, with Action
Surge — stays one line:

```ts
const sword = d20.plus(9).ac(16).onHit(d6.plus(5));

turn().attacks(4, sword).onEveryHit(d6).mean(); // 35.0  — hunter's mark on each hit
turn().attacks(8, sword).onEveryHit(d6).mean(); // 70.0  — action surge
```

### At most N times

`onEveryHit(damage, { max })` applies the rider to at most `max` landings, in turn order, each in its
own hit's mode: Superiority dice on the fighter's first two hits. The cap is exact, not a mean
adjustment: every attack carries a draw with the rider and one without, and the walk picks between
them by how many landings the rider has already used.

```ts
const maneuvers = turn().attacks(4, sword).onEveryHit(d8, { max: 2, id: "maneuvers" });

maneuvers.mean();                            // 33.7003  (24.5 with no rider, 38.0 on every hit)
maneuvers.fireProbability("maneuvers");      // 0.9919   P(the rider applied at least once)
maneuvers.expectedApplications("maneuvers"); // 1.9082   E[min(hits, 2)]
```

One rider model covers all three: `onFirstHit` applies once, `onEveryHit(damage, { max: n })` at most
`n` times, and `onEveryHit` with no `max` every time. `{ max: 1 }` **is** `onFirstHit`: the plan
lowers it, so `otherwise`, `not-fired`, being named in another rider's `of` and the numbers are
`onFirstHit`'s, bit for bit. A cap at or above the number of attacks it watches is `onEveryHit`, bit
for bit too. In a spec, the cap is the rider's `max`: `{ on: "every-hit", of, max: 2, damage }`. A cap
must be a positive integer; it is refused on any other trigger and beside a grant, which is never
capped. A capped rider cannot watch an `onAnyMiss` reroll (that reroll resolves after every declared
attack, so a cap would count its landing in the wrong order): use `onFirstMiss`.

`expectedApplications(id)` answers for any rider: the expected count for an every-hit rider (2.8
above, uncapped), the same number as `fireProbability(id)` for a rider that applies at most once.

`perSource` gives a payload that depends on which attack landed (its damage type, the target's scale
for it), on `onFirstHit` and `onEveryHit`. A source it does not list deals the call's damage; each
entry brings its own `critDamage`, or has its dice doubled:

```ts
turn([sword, dagger]).onFirstHit(d6, {
  perSource: { "attack 2": { damage: d10 } },   // the dagger row's rider is d10
}).mean();                                       // 14.255
```

A per-source first hit is still one rider (`fireProbability`, `otherwise` and `not-fired` read it),
but it is applied inside its attacks' draws, so no other rider can name it in `of`. Its damage, `critDamage` and
payloads are damage, not attacks, and the same holds for a capped or per-source `onEveryHit`: a bonus attack is
a plain `onFirstHit` rider. (An uncapped `onEveryHit` still takes an attack as its damage.)

Over a save row (a rider reads it through its `landing` option) a cap counts the save as a landing only where its
kind says, so riders that differ only in their `landing` keep separate counters.

Riders over the same attacks with the same `max` share one counter. Each different cap of 2 or more
(or source set) doubles the draws every attack it watches carries, so a turn is limited to
`MAX_CAPPED_COUNTERS` (6) per attack (`too-many-counters`).

### A rider can be anything that makes damage

Riders take the same builders attacks do, so "extra damage" and "an extra attack" are the same call.
A whole attack, a list of attacks, a flat bonus, or a saving throw all work:

```ts
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const sword = d20.plus(9).ac(16).onHit(d6.plus(5));
const greatsword = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));
const poison = d20.dc(13).onSaveFailure(roll(3, d6)).saveHalf();

turn([greatsword, greatsword]).onAnyCrit(greatsword);   // Great Weapon Master's bonus attack
turn([dagger]).onFirstHit(poison);                      // hit, then the target saves
turn([sword, sword]).onEveryHit(flat(2));               // Rage
turn([dagger, dagger]).onAnyCrit(roll(4, d8)).otherwise([unarmed, unarmed]); // smite, or flurry
```

A list of attacks deals their exact summed damage, but it is one payload, not attacks that each
land: it is not a watchable attack. Naming it in `of` throws `not-an-attack`, and it never joins a
later rider's default `of`. To watch each strike, give each strike its own rider.

### The hard build

A goliath rogue/monk/paladin, every trigger at once:

```ts
const goliath = turn([dagger, dagger])
  .onFirstHit(roll(3, d6))       // sneak attack
  .onFirstHit(d10)               // fire's burn
  .onAnyCrit(roll(2, d8))        // divine smite
  .otherwise([unarmed, unarmed]) // flurry of blows, if the smite didn't happen
  .onEveryHit(d6);               // hunter's mark, on the daggers

goliath.mean();                                // 39.5903
goliath.toQuery().damageAttributionChartModel();
```

Two things that would be easy to get wrong are handled for you. Riders sharing a trigger resolve
**jointly** — sneak attack and fire's burn fire together or not at all, which shows up in the spread
even though it never moves the mean. And `otherwise()` binds to the rider immediately before it, so
the smite and the flurry are two branches of one decision and can never both land. The mark
watches the two daggers: the flurry is a list rider, which no rider watches.

### Asking questions

```ts
const t = turn([dagger, dagger]).onFirstHit(roll(3, d6));

t.mean();                                   // 18.6225
t.pmf.pAt(0);                               // 0.1225  — P(whiff)
t.pmf.stdev();                              // 8.8860
t.toQuery().probTotalAtLeast(20);           // 0.5062  — P(20+ damage)
t.toQuery().percentiles([0.25, 0.5, 0.75]); // [15, 20, 24]
```

### Once per turn: keep the better damage roll

`onFirstHit` also takes a **transform** instead of damage. `keepBestDamage()` rolls the attack's own
base payload a second time and keeps the better total — once per turn, on the first attack that
lands. No dice are restated, and one call covers every attack in the turn:

```ts
import { keepBestDamage } from "@yipe/dice/builder";

const attack = d20.plus(5).ac(12).onHit(roll(2, d6).plus(3));

turn([attack, attack]).mean();                               // 14.7000
turn([attack, attack]).onFirstHit(keepBestDamage()).mean();  // 15.9849
```

What it rerolls is the **base payload**: a crit transforms the doubled crit dice, while
`plusSeparateDamage` channels, `every-hit` riders and the miss branch are never rerolled. Spending
on the first landing is a policy, and not the best one — a player who sees a high roll holds the
reroll — so the number is a lower bound. `keepBestDamage().ifBelow({ hit, crit })` spends only when
the base payload total (dice plus the payload's own flat bonus, excluding separate-damage channels)
is below the threshold for that mode. When no later attack it watches can still land — the last
one, or an earlier one whose watched reroll can no longer fire — it spends on any landing.
`ifBelow({ hit: 10, crit: 18 })` reaches the optimum on the turn above, and since the threshold
reads the payload's own values it works on a parsed string or a bare `PMF` too.
On a tie the original roll is kept; the total is the same, so that only matters to a dice-match
trigger reading the same attack.
`fireProbability(id)` reports P(spent). A second transform over any of the same attacks throws
`duplicate-substitute`, and a transform passed to any other verb throws `unsupported-trigger`.

### Conditions: advantage, disadvantage and crits granted by earlier attacks

The same verbs take a **grant** — a modifier with a lifetime — for the attack rolls after it:

```ts
import { advantage, d12, d20, d6, d8, disadvantage, roll, turn } from "@yipe/dice/builder";

const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const axe = d20.plus(7).ac(15).onHit(d12.plus(4));
const bow = d20.plus(6).ac(15).onHit(d8.plus(3));
const fist = d20.plus(8).ac(16).onHit(d6.plus(5));
const dc = d20.plus(2).dc(15); // the target's saving throw

// A hit gives the next attack advantage. The next attack uses it up even on a miss, and passes it
// on if it lands.
turn([sword, sword]).onEveryHit(advantage().untilNextAttack()).mean();        // 12.202125
turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack()).mean(); // 19.192196

// A hit gives advantage for the rest of the turn if the target fails a save; each landing tries again.
turn([axe, axe]).onEveryHit(advantage().untilEndOfTurn(), { save: dc });

// Once per turn, on the first hit, 40% of the time: advantage, and every later hit is a crit.
turn([fist, fist, fist]).onFirstHit(advantage().critOnHit().untilEndOfTurn(), { chance: 0.4 });

// One save, two grants: advantage for the later melee attacks, disadvantage for the ranged ones.
turn().attacks(2, axe, { tag: "melee" }).attack(bow, { tag: "ranged" })
  .onEveryHit([advantage().untilEndOfTurn().to("melee"),
               disadvantage().untilEndOfTurn().to("ranged")], { of: ["melee"], save: dc });
```

`advantage()`, `disadvantage()` and `critOnHit()` are not grants until they get a lifetime, so
`onEveryHit(advantage())` does not compile. A grant combines with the reading attack's own roll
type by cancellation — advantage and disadvantage together roll flat — and a net advantage rolls
three dice for an attack built with `threeDiceAdvantage()`. `critOnHit` makes every landing a crit;
a natural 1 still misses. `.to(…)` takes ids or tags; left out, every later attack roll reads the
grant, rerolls and bonus attacks included. An `onAnyMiss` reroll resolves after every attack, so one
that would read a grant, or apply one, throws `unsupported-trigger`: use `onFirstMiss`, which
resolves right after the miss and reads the grants in force there.

`chance` or `save` gates the grants only: damage in the same call (`[d8, advantage()…]`) lands
whatever the save does. `onEveryHit` rolls the save again on each landing until it takes, and
`onFirstHit` rolls it once. An application whose grants are all `untilEndOfTurn` and all already
in force rolls no further save; one with any `untilNextAttack` grant always rolls.
`onSave` applies other grants on the success branch of the same roll:
`{ chance: 0.4, onSave: advantage().untilNextAttack() }`. `fireProbability(id)` reports P(the grants
were applied where a later attack reads them). In plain data it is `TurnSpec.conditions`, with the
`save` already turned into its `chance`.

### Effects cookbook: every combination, fluently

An effect has four parts, and each has a spelling:

| part | options | spelling |
|---|---|---|
| when | every hit · any crit · the turn's first hit | `attack.onEveryHit(…)` · `attack.onAnyCrit(…)` · `turn.onFirstHit(…)` |
| what | advantage · disadvantage · every hit is a crit | `advantage()` · `disadvantage()` · `critOnHit()`, chainable: `advantage().critOnHit()` |
| how long | the next attack · the rest of the turn | `.untilNextAttack()` · `.untilEndOfTurn()` |
| gate | always · a chance · the target's save, with an optional consolation | nothing · `{ chance: 0.4 }` · `{ save: d20.plus(3).dc(15) }`, `{ save, onSave: advantage().untilNextAttack() }` |

Every-hit and any-crit effects belong to the attack that grants them, so attach them to it. The
result is a new builder; the receiver is unchanged. `turn()`, `Turn.from()` and `turn().attack()` all
read an attached effect as one condition watching that attack. Once-per-turn effects fire on the
turn's first hit whichever attack lands it, so they are turn verbs. Every number below is exact; each
example is exported from `src/builder/example.ts` and pinned in its test.

```ts
import { advantage, critOnHit, d20, d4, d6, d8, flat, roll, turn } from "@yipe/dice/builder";

const shortsword = d20.plus(8).ac(16).onHit(d6.plus(5));
const dagger = d20.plus(8).ac(16).onHit(d4.plus(5));
const staff = d20.plus(8).ac(16).onHit(d8.plus(5));
const fist = d20.plus(8).ac(16).onHit(d6.plus(5));

// Every hit: advantage on the next attack (the shape of Vex).
const sword = shortsword.onEveryHit(advantage().untilNextAttack());
turn([sword, sword, dagger]).mean();            // 19.2211   (no effect: 16.4000)
turn().attacks(4, sword).mean();                // 27.5867   — the chain passes along, swing by swing

// The same grant, limited to some readers: the dagger attacks another creature.
turn()
  .attacks(2, shortsword, { tag: "sword" })
  .attack(dagger)
  .onEveryHit(advantage().untilNextAttack().to("sword"), { of: ["sword"] })
  .mean();                                      // 17.7650

// Every hit, 40% of the time.
turn([shortsword.onEveryHit(advantage().untilNextAttack(), { chance: 0.4 }), shortsword]).mean(); // 11.9460

// Every hit, gated by the target's save, for the rest of the turn (the shape of Topple).
// Each landing retries the save until it fails; once it has, later landings roll nothing.
const toppling = staff.onEveryHit(advantage().untilEndOfTurn(), { save: d20.plus(3).dc(15) });
turn([toppling, toppling, dagger]).mean();      // 19.7207

// Any crit: advantage for the rest of the turn.
turn([shortsword.onAnyCrit(advantage().untilEndOfTurn()), shortsword, shortsword]).mean(); // 17.3100

// Two modifiers in one grant: advantage, and every later hit is a crit.
turn([shortsword.onEveryHit(advantage().critOnHit().untilEndOfTurn()), shortsword]).mean(); // 14.5395

// The turn's first hit: every later hit this turn is a crit.
turn([shortsword, shortsword]).onFirstHit(critOnHit().untilEndOfTurn()).mean(); // 12.7650

// The turn's first hit, with a save deciding between two outcomes (the shape of Stunning Strike):
// a failed save gives advantage for the rest of the turn, a success still gives the next attack.
turn([fist, fist, fist])
  .onFirstHit(advantage().untilEndOfTurn(), {
    save: d20.plus(2).dc(15),
    onSave: advantage().untilNextAttack(),
  })
  .mean();                                      // 19.7618

// Damage and a grant on the same first hit, in one list, on top of the attached effect.
turn([sword, sword, dagger]).onFirstHit([roll(3, d6), advantage().untilEndOfTurn()]).mean(); // 30.1893

// A gate covers grants, never damage (the shape of Trip Attack). Two calls on one trigger resolve
// jointly; giving the grant its own call lets you ask how often it applied.
const tripping = turn([shortsword, shortsword, dagger])
  .onFirstHit(d8)
  .onFirstHit(advantage().untilEndOfTurn(), { save: d20.plus(4).dc(15), id: "advantage" });
tripping.mean();                                // 22.5216
tripping.fireProbability("advantage");          // 0.4388 — applied where a later attack reads it

// What the target already has when the turn starts, in 60% of rounds: a step that always hits
// for 0 goes first, and its grant reaches every attack after it.
const start = d20.alwaysHits().onHit(flat(0)).onEveryHit(advantage().critOnHit().untilEndOfTurn(), { chance: 0.6 });
turn([start, shortsword, shortsword]).mean();   // 17.1960   (every round: 21.0600)

// An attack that happens in only some rounds: give it a chance. A not-happened attack is no
// miss and no landing, so a skipped round never uses up a next-attack grant (gating its PMF
// in place would).
const sword9 = d20.plus(9).ac(16).onHit(d6.plus(5)).onEveryHit(advantage().untilNextAttack());
const knife9 = d20.plus(9).ac(16).onHit(d4.plus(5));
turn([sword9, knife9]).attack(sword9, { chance: 0.5 }).mean(); // 15.7481
```

Effects compose without precedence rules. Advantage is a set, not a counter, so two sources of it
are one advantage, and a grant cancels against the reading attack's own disadvantage. Everything at
once, with two rapiers granting next-attack advantage, two fists, a d6 on the first hit and the
save-or-next-attack condition, is still one exact turn. `stepStats(id)` reports how often each swing
had advantage:

```ts
const rapier = d20.plus(8).ac(16).onHit(d8.plus(5)).onEveryHit(advantage().untilNextAttack());
const smallFist = d20.plus(8).ac(16).onHit(d6.plus(4));
const t = turn([rapier, rapier, smallFist, smallFist])
  .onFirstHit(d6)
  .onFirstHit(advantage().untilEndOfTurn(), { save: d20.plus(2).dc(15), onSave: advantage().untilNextAttack() });

t.mean();                                                 // 30.8749
t.attackIds.map((id) => t.stepStats(id).live.advantage);  // [0, 0.65, 0.8457, 0.6061]
t.stepStats("attack 2");  // { rolled: 1, hit: 0.7979, crit: 0.0809, live: { advantage: 0.65, … } }
```

`stepStats(id)` works for any declared attack or attack-shaped rider. `hit` includes crits. `live.*`
is the chance that each modifier was in force when the swing read it, before the swing used it up.
`rolled` is 1 for a declared attack and the fire probability for a rider. An effect attached to an
attack used as a rider throws `unsupported-trigger`: spell it with the turn's verbs instead.

### Rerolls, sweeping AC, and naming attacks

A reroll is an attack-shaped rider. `onFirstMiss(attack)` resolves right after the attack that
missed, so anything that reads order — a `first-hit` rider's crit mode, a granted advantage — sees
it where it happened. A rider or transform added *after* an `onAnyMiss` / `onFirstMiss` reroll
watches it without being told:

```ts
turn([sword, sword])
  .onFirstMiss(sword)       // reroll the first miss
  .onFirstHit(roll(1, d10)) // watches both attacks and the reroll
```

`vsAC(ac)` rebuilds every attack with an AC — including rerolls and bonus attacks carried by
riders — for a DPR-by-AC sweep, leaving saves untouched:

```ts
const base = turn([sword, sword]).onFirstHit(roll(3, d6));
[12, 14, 16, 18].map((ac) => base.vsAC(ac).mean());
```

`attack(source, { tag })` and `attacks(n, source, { tag })` name a group of attacks, and an `of`
entry that is not an id expands to every attack with that tag — so reordering a turn cannot
silently retarget a rider the way a positional `attack 2` can.

An attack also takes a `chance` — the probability it happens at all, in `[0, 1]`. With
`1 − chance` probability it does not happen: no damage, and it is **not** a miss (`any-miss` /
`first-miss`) or a landing (hit triggers), so a skipped attack never spends a `next-attack`
grant. `chance: 1` is the default and byte-identical to leaving it out:

```ts
turn([sword, sword]).attack(sword, { chance: 0.5 });  // the third swing happens half the time
```

### Riders over saving throws

A save has no hit or crit to land on, so a rider cannot watch one until it says how the save lands.
Pass `landing`: `"fail"` counts a failed save as a hit; `"damage"` counts a failed save or a pass that
deals save-for-half damage, as long as it dealt some (the "when you deal damage" reading). An attack
among the sources lands on a hit or a crit either way, and a save never crits:

```ts
const fireball = d20.dc(15).onSaveFailure(roll(8, d6)).saveHalf();

const t = turn([dagger, fireball]).onFirstHit(roll(2, d6), { landing: "fail", id: "rider" });
t.fireProbability("rider"); // 0.8950: unless the dagger missed (0.35) and the target passed (0.30)
t.mean();                   // 34.6900, and 28.0750 without the rider
```

The rider fires in the mode of the first thing that landed, in the order the rows are declared: a
dagger crit doubles its dice, a failed save does not. `"fail"` reads the outcome label alone, so a
failure that dealt 0 still lands; `"damage"` needs damage above 0, so a pass whose halved damage
floors to 0 does not. `first-miss` and `any-miss` fire on a save that did not
land. Riders may read one save row under different kinds: a `"fail"` feature and a `"damage"` feature
over the same save each see it their own way. Without `landing` a save row is `not-an-attack`, as
before. Only a declared save row can be watched this way, not a save that a rider carries as its
damage.

### Probes: P(any crit) without the damage

`observeAnyCrit(id)` reports the probability that at least one source crit, through
`fireProbability(id)`, and adds no damage. It comes from the walk itself, so a crit-on-hit grant, a
reroll, a substitute and an attack's `chance` are all counted. The probe watches `of`, which defaults
like a rider's, and skips the rows that cannot crit (a save, a flat payload), so it works on a mixed
turn; a probe with nothing that can crit reports 0:

```ts
turn().attacks(4, sword).observeAnyCrit("crit").fireProbability("crit"); // 0.1855, which is 1 - 0.95^4
turn([sword, sword, sword]).observeAnyCrit("outer", { of: ["attack 1", "attack 3"] });
```

A probe is read from a walk that carries no damage distribution, only the probability of each path,
so it costs a small fraction of `mean()` (a 7-attack turn with five kinds of riders: 0.3ms against
108ms). Reading `pmf`, `mean()`, `toQuery()` or any other id's `fireProbability` still walks the
damage. A probe keeps the group of its sources live to the end of the walk, so it counts against
`MAX_TRIGGER_GROUPS` for the whole turn. In plain data it is `TurnSpec.observe`:
`{ id, on: "any-crit", of }`, and `probeIds` lists them.

### Ids, errors, and plain data

Nothing above needs an `id`: attacks and riders get `attack 1`, `rider 2`, … in declaration order,
and `otherwise()` finds its own target. Name a rider when you want to ask about it afterwards:

```ts
const paladin = turn([dagger, dagger]).onAnyCrit(roll(2, d8), { id: "smite" });

paladin.fireProbability("smite"); // 0.0975
paladin.attackIds;                // ["attack 1", "attack 2"]
paladin.riderIds;                 // ["smite"]
```

Every construction path validates immediately and throws a `TurnSpecError` whose `code` —
`unknown-id`, `cycle`, `not-an-attack`, `duplicate-id`, `self-reference`, `unused-crit-damage`,
`too-many-groups`, `no-dice-descriptor`, `duplicate-substitute`, `attack-after-rider`,
`no-rebindable-source`, `unsupported-trigger`, `unsupported-policy`, `too-many-states`,
`unknown-key`, `non-string-id` — maps straight onto a UI field state. A bad `of` fails at the
call that introduced it, not later at `.mean()`. An attack wrapper carries only `source`, `id`,
`tag` and `chance`: any other key is `unknown-key`, and an id or tag that is not a string is
`non-string-id`.

`too-many-groups` counts the source sets a turn keeps live at once, at most `MAX_TRIGGER_GROUPS` (9). A
group is live from the first attack it watches to the last rider that reads it, and groups whose
lives do not overlap share a slot, so a turn may name more source sets than that as long as no more
are live together. A `bounce()` chain keeps two live whatever its length.

Each `onX` method takes an optional `{ id, of, critDamage, landing }`, where `of` picks which attacks the
rider watches. Left out, it is filled in at that call: the attacks declared so far, plus any reroll
declared so far. So declare attacks first — `.attack()` after such a rider throws
`attack-after-rider` rather than silently leaving the new attack out. `Turn.from` fills an omitted
`of` the same way — every attack plus the rerolls, for a rider the rerolls listed before it — so
both spellings of a turn watch the same sources. All of them are sugar over `rider()`, which takes the
trigger as plain data — and `Trigger` is JSON-safe, so a UI can persist one and hand it straight
back:

```ts
import { Turn, d20, d4, d6, roll } from "@yipe/dice/builder";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));

const fromUI = Turn.from({
  attacks: [{ id: "dagger 1", source: dagger }, { id: "dagger 2", source: dagger }],
  riders: [{ id: "sneak", damage: roll(3, d6), on: "first-hit" }],
});
```

## Conditions: what the target has, and what it gets

A **condition** is a rule plus a lifetime: what it does to the rows that read it (advantage on attacks, a crit on
every melee hit, an automatic failure on STR saves) and when it ends. `@yipe/dice/dnd5e` names the six the rules
use (`blinded`, `paralyzed`, `prone`, `restrained`, `stunned`, `unconscious`) and `condition(name, rule)` takes any
other. Some rules depend on the row, so rows say what they are: `melee()` / `ranged()` on an attack (Prone gives
melee advantage and ranged disadvantage), an ability on a save (Stunned fails STR and DEX saves): `ability("con")`
on a DC check, or `saveDC(15, { con: 2 })` from `@yipe/dice/dnd5e` for a trigger's save. Beside
conditions sit plain effects on the target: `vulnerability()` for the next hit, and `saveDisadvantage()` /
`savePenalty(d4)` for its saves.

**`melee()` and `ranged()` stand for distance.** The rules key Prone, Paralyzed and Unconscious on whether the
attacker is within 5 feet, and a turn does not model distance. For condition rules, `melee()` means an attack from
within 5 feet and `ranged()` an attack from farther away: a reach attack made from 10 feet should be declared
`ranged()` (no advantage against a Prone target, no automatic crit against a Paralyzed one).

The verbs are the same ones the effects above use. `atStart` is what the target already has; a trigger verb
(`onFirstHit`, `onEveryHit`, `onAnyCrit`, `onFirstCrit`) is what it gets, behind an optional save or chance. Each
example below is exported from `src/builder/example.ts` and pinned in its test to the brute-force oracle
(`tests/oracle/bruteForce.ts`, which shares no code with the library) at 1e-12; `yarn example conditions` prints
them. All attacks are +8 vs AC 16.

```ts
import { advantage, d20, d4, d6, d8, flat, roll, savePenalty, turn, vulnerability } from "@yipe/dice/builder";
import { contestLossChance, prone, restrained, saveDC, stunned, unconscious } from "@yipe/dice/dnd5e";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
const fist = d20.plus(8).ac(16).onHit(d6.plus(4));

// Vex: a hit gives the next attack advantage.
turn([sword.onEveryHit(advantage().untilNextAttack()), sword]).mean(); // 12.8959

// Topple: a toppling hit may knock the target Prone (CON save). Prone helps the swords after it and
// costs the bow, so with `optional` the player topples with the first sword and not with the third.
const topple = (optional: boolean) =>
  sword.onEveryHit(prone().untilEndOfTurn(), { save: saveDC(15, { con: 3 }), ...(optional ? { optional: true as const } : {}) });
turn([topple(true), sword, topple(true), bow]).mean(); // 23.7677
turn([topple(false), sword, topple(false), bow]).mean(); // 23.2745: toppling every time
turn([sword, sword, sword, bow]).mean(); // 23.0000: never toppling

// 2024 Stunning Strike: once a turn, a failed save stuns; a pass still gives the next attack advantage.
const monk = turn([fist, fist, fist]).onFirstHit(stunned().untilEndOfTurn(), {
  id: "stun", save: saveDC(15, { con: 2 }), onSave: advantage().untilNextAttack(),
});
monk.mean(); // 17.5234
monk.fireProbability("stun"); // 0.5265: stunned where a later fist reads it
monk.stepStats("attack 3").live.advantage; // 0.6175: the third fist rolls with advantage

// 2024 Grappler: the target saves with STR or DEX, whichever it passes more often.
const saves = saveDC(15, { str: 5, dex: 1 });
turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { save: saves }).mean(); // 12.1281

// 2014 shove: an Athletics contest (+5 against +7; ties go to the defender) replaces the first attack and
// knocks the target Prone, so the melee attack after it has advantage. (A 2014 grapple gives no advantage.)
const shove = d20.alwaysHits().melee().onHit(flat(0))
  .onEveryHit(prone().untilEndOfTurn(), { chance: contestLossChance({ attacker: 5, defender: 7 }) });
turn([shove, sword]).mean(); // 6.5714

// Cunning Strike (Knock Out): on the hit that carries Sneak Attack, a CON save or Unconscious until damaged.
turn([sword, sword, sword])
  .onFirstHit(roll(3, d6), { id: "sneak" })
  .onFirstHit(unconscious().untilDamaged(), { of: ["sneak"], save: saveDC(15, { con: 2 }) })
  .mean(); // 32.0568

// 2014 Path to the Grave: the cursed creature is vulnerable to the next hit's whole damage.
turn([sword, sword]).atStart(vulnerability().untilNextHit()).mean(); // 19.2625

// The target starts the turn Restrained; a second creature has its own state.
turn().attacks(2, sword).attack(sword, { target: "second" }).atStart(restrained()).mean(); // 21.5450
```

Unconscious that ends on damage leaves the creature Prone for the rest of the turn (its rule's `onEnd`), so the
hit that wakes it still reads it, and the swings after read Prone. An `optional` condition is decided by search:
with up to three in a turn, every subset is tried and the best mean kept (the full set wins a tie); past three,
each is tried where the later attacks on its creature lean melee.

### Conditions that need a damage type

`dealing: "cold"` lands only where the hit dealt cold damage. The turn asks the row for the odds it did through
`dealt(type, context)` on a `ContextualSource`. `attack.typed("cold")` says the attack's whole damage is that type:
its `dealt` is P(damage > 0) given a hit and given a crit, so a hit that rolls 0 deals nothing. An untyped attack has
no `dealt`, and a `dealing` condition that reads it is `not-an-attack`. A row that deals several types needs a
hand-written `ContextualSource` whose `dealt` knows the split. With `dealing`, `mean()` and `marginal(id)` are exact,
and the joint `pmf` throws `dealing-joint-unsupported`: the turn knows the odds a landing dealt the type, not which
damage it was.

```ts
// Cold Caster's Frostbite: once a turn, a cold hit takes 1d4 off the target's next save.
const ray = d20.plus(7).ac(16).onHit(roll(2, d8)).typed("cold");
const breath = d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(4, d6)).saveHalf();
const caster = turn().attack(ray, "ray").attack(breath, "breath")
  .onFirstHit(savePenalty(d4).untilNextSave(), { of: ["ray"], dealing: "cold" });
caster.marginal("breath").pmf.mean(); // 10.5563
```

### Factories, lifetimes, verbs and options

| Effect                                                                           | Lifetimes                                     | Notes                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `advantage()`, `disadvantage()`, `critOnHit()` (chainable)                       | `untilNextAttack()`, `untilEndOfTurn()`       | `.to(ids or tags)` limits the readers                    |
| `blinded()`, `paralyzed()`, `prone()`, `restrained()`, `stunned()`, `unconscious()` | `untilEndOfTurn()`, `untilDamaged()`       | from `@yipe/dice/dnd5e`, each rule in `RULES`; `condition(name, rule)` for any other |
| `vulnerability()`                                                                | `untilNextHit()`                              | the hit's whole damage doubles, riders included          |
| `saveDisadvantage()`, `savePenalty(d4)`                                          | `untilNextSave()`, `untilEndOfTurn()`         | `savePenalty` takes one plain die group; `.to(...)`      |

A `next-save` effect is used up by the target's next save row. A trigger's own save (`save: …`) is no row: it
reads the effects that last the turn on its creature (a condition's rule, `untilEndOfTurn()` save effects not
scoped with `.to(...)`), never a `next-save` one.

| Verb                                                    | On                                       | Fires                                       |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| `turn.atStart(effect, { target })`                      | the turn                                 | before the first row; no lifetime means the turn |
| `turn.onFirstHit(effect, options)`                      | the turn                                 | the first landing among `of`                |
| `turn.onEveryHit(effect, options)` / `attack.onEveryHit` | the turn, or attached to an attack      | every landing (attached: that attack's)     |
| `turn.onAnyCrit` / `turn.onFirstCrit` / `attack.onAnyCrit` / `attack.onFirstCrit` | either | a crit, every time / once                   |
| `dc.onSaveFailure([damage, effect])`                    | a save                                   | that save failed                            |

| Option              | Meaning                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `save`              | the target's save, rolled in its state: a DC check, `saveDC(dc, { con: 2 })`, or a list it picks the likeliest pass from |
| `chance`            | a fixed P(the effects take), instead of a save (`contestLossChance` for a contest)        |
| `onSave`            | effects on the other branch: the save passed, or `1 - chance`                             |
| `of`, `id`          | the rows or riders watched (a rider id: land with that rider), and a name to read it by   |
| `dealing`           | the landing must deal this damage type; the row says its type with `typed("cold")` (see above) |
| `optional: true`    | "you can": taken only where it raises the mean                                            |

A trigger's effects go on the creature of the row that lands them (`attack(source, { target })` aims a row);
a trigger takes no `target` (`unsupported-trigger`). Only `atStart(effect, { target })` names one, and it must be
`"target"` or a creature some attack is aimed at (`unknown-id` otherwise).

A DC check given as `save` keeps everything it says and is rolled in the target's state (save disadvantage,
penalty dice). A plain one (a d20 plus a flat bonus) is the save `{ ability, dc, bonus, rollType }`; one with
bonus dice (Bless `.plus(d4)`), a reroll (`d20.reroll(1)`), `pinned()` or `alwaysFails()` is rolled as written.
With nothing in force it is its own P(fail), the 0.16 gate. It needs an `ability(...)` only where a rule in the
turn reads saves by ability (`save-without-ability` otherwise, as for a save row). Abilities may be spelled `str`
or `strength`, in a save and in a rule's `save` keys alike.

| Row fact                         | On                         | Means                                                                    |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `melee()` / `ranged()`           | an attack                  | from within 5 feet / from farther away, for condition rules (see above)  |
| `ability("con")`                 | a DC check or a save       | the ability the save is made with, for rules keyed by ability            |
| `pinned()`                       | a roll, check, or save     | no grant or condition changes this roll's advantage or disadvantage     |
| `alwaysFails()`                  | a DC check or a save       | the save fails without rolling                                           |
| `turn.stateLimit(n)`             | the turn                   | the most distinct states the walk may carry (default 16,384); more is `too-many-states` |

| Sugar                                  | Is                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `saveDC(15, { con: 2 })`               | `{ ability: "constitution", dc: 15, bonus: 2 }`; several abilities give the list the target picks from; `TypeError` on none, an unknown or repeated one, or a non-integer |
| `attack.typed("cold")`                 | the attack's whole damage is cold: `dealt("cold", context)` is P(damage > 0 \| hit) and \| crit; any other type is 0 |

| Reader                        | Returns                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `mean()`                      | the turn's expected damage                                                                  |
| `marginal(id).pmf`            | one attack's or rider's own damage; the marginals' means add up to the mean                 |
| `fireProbability(id)`         | P(a condition was applied where a later row reads it); 1 for a `start` condition           |
| `attemptProbability(id)`      | the expected number of times a condition is tried (for a `first-*` one, the odds it is)     |
| `stepStats(id).live`          | how often each effect was in force when the row rolled, with the part each source accounts for |
| `stepStats(id).conditions`    | each condition the row tried: the odds it was attempted there and the odds it took          |
| `landings(id)`                | the ways riders land on attack `id` together, per outcome, with their odds                 |
| `conditionIds`                | the turn's condition ids, declared and attached, in order                                   |
| `peakStates`                  | the most states the walk held after any step                                                |

### Errors

| Code                        | Cause                                                              | Fix                                                        |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `unknown-range`             | a rule keyed by range (Prone, Unconscious) reads a row with none   | add `.melee()` or `.ranged()` to the attack                |
| `unknown-ability`           | a save or a rule's `save` key names no 5e ability                  | use `str`/`dex`/`con`/`int`/`wis`/`cha` or the full name   |
| `save-without-ability`      | a rule keyed by ability (Stunned, Restrained) reads a save row or a trigger's save with none | add `.ability("dex")` to the DC check |
| `too-many-states`           | more effects live at once than the walk holds, or past `stateLimit` | drop or scope effects (`.to`, `of`), or raise `stateLimit(n)` |
| `dealing-joint-unsupported` | the joint `pmf` of a turn with `dealing`                           | read `mean()` or `marginal(id)` instead                    |
| `no-rebindable-source`      | an effect reaches a row with no check to re-derive (a bare PMF, a list of payloads), or a rider `joins` a row whose source does not pool rider dice | scope the effect with `.to(...)`, or make the row a `ContextualSource` (for `joins`, one whose `under(context)` rolls `context.joined`) |

A rider's `joins` rolls its dice inside the row's own roll, so the row's source must pool them: a
`ContextualSource` whose `under(context)` adds the dice of the riders in `context.joined`. The library's attack and
save builders do not, nor does a plain PMF, and a rider that joins one is `no-rebindable-source`.

## Statistics and charts

```ts
import { parse } from "@yipe/dice";

const query = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").query();
console.table(query.toChartSeries());
```

**Output:**

```
┌─────────┬────┬──────────┐
│ (index) │ x  │ y        │
├─────────┼────┼──────────┤
│ 0       │ 0  │ 0.35     │
│ 1       │ 5  │ 0.15     │
│ 2       │ 6  │ 0.153125 │
│ 3       │ 7  │ 0.15625  │
│ 4       │ 8  │ 0.159375 │
│ 5       │ 9  │ 0.0125   │
│ 6       │ 10 │ 0.009375 │
│ 7       │ 11 │ 0.00625  │
│ 8       │ 12 │ 0.003125 │
└─────────┴────┴──────────┘
```

Percentiles and `quantile()` land on the exact bin, so a d20's median is 10. `missChance()` is the
probability that at least one attack misses; for "every attack misses" use
`probExactlyK(["missNone", "missDamage"], n)`. `turn()`, `Turn.from()` and `resolve()` keep every
reachable damage value (their `eps` defaults to 0). `setCachingEnabled(false)` turns off and
empties every internal cache; PMFs returned from a cache have frozen bins.

## Architecture

### Core concepts

| Concept    | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| **PMF**    | Probability Mass Function. The core mathematical representation of outcomes. |
| **Query**  | Runs calculations and scenarios over one or more PMFs.                       |
| **Parser** | Parses text-based dice expressions like `(d20 + 8 AC 16) * (1d4 + 4)`.       |
| **Builder**| Fluent TypeScript API for building dice expressions.                         |
| **AST**    | Abstract Syntax Tree representing dice operations.                           |

### Project Structure

```
src/
├── builder/          # Fluent API for building dice expressions
│   ├── factory.ts    # Factory functions (d20, d6, roll, etc.)
│   ├── roll.ts       # RollBuilder - core builder class
│   ├── ac.ts         # ACBuilder - attack roll builder
│   ├── attack.ts     # AttackBuilder - attack with damage
│   ├── save.ts       # SaveBuilder - saving throw builder
│   ├── dc.ts         # DCBuilder - difficulty check builder
│   ├── ast.ts        # AST generation and PMF conversion
│   └── nodes.ts      # AST node type definitions
├── parser/           # String-based dice expression parser
│   ├── parser.ts     # Main parser implementation
│   └── dice.ts       # Dice class (legacy parser representation)
├── turn/             # Turns: attacks + conditional damage riders
│   ├── types.ts      # Trigger, Rider, TurnSpec, TurnSpecError
│   ├── plan.ts       # Spec validation and step/group resolution
│   ├── state.ts      # Packed per-group trigger state
│   └── turn.ts       # Turn class - exact joint distribution
├── pmf/              # Probability Mass Function core
│   ├── pmf.ts        # PMF class - core data structure
│   ├── query.ts      # DiceQuery - analysis interface
│   └── mixture.ts   # Mixture operations
└── common/           # Shared utilities
    ├── types.ts      # Type definitions
    └── lru-cache.ts  # LRU cache implementation
```

The library provides two parallel entry points for creating dice expressions:

### Entry Point 1: String Parser

Parses text expressions like `"(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"`:

```
String Expression
    │
    ├─ parse() ──────────────┐
    │                        │
    │                        ▼
    │             parseExpression()
    │                        │
    │                        ├─ parseArgument() ──► Dice objects
    │                        │
    │                        └─ parseOperation() ──► Dice operations
    │                        │
    │                        ▼
    │             Dice.toPMF() ──► PMF
    │                        │
    └────────────────────────┘
```

### Entry Point 2: Fluent Builder API

Type-safe builder pattern:

```
RollBuilder (d20, d6, roll(), etc.)
    │
    ├─ .plus() ──► RollBuilder
    ├─ .ac() ────► ACBuilder
    │                 │
    │                 └─ .onHit() ──► AttackBuilder
    │                                    │
    │                                    ├─ .mean() ─────► number (expected damage)
    │                                    ├─ .toQuery() ──► DiceQuery
    │                                    └─ .pmf ────────► PMF
    │
    └─ .toPMF() ──► PMF
```

### Core Class Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    User Input Layer                         │
├─────────────────────────────────────────────────────────────┤
│  String Parser          │  Fluent Builder                   │
│  parse("...")           │  d20.plus(8).ac(16)               │
└────────────┬────────────┴────────────┬──────────────────────┘
             │                         │
             ▼                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Builder Layer                            │
├─────────────────────────────────────────────────────────────┤
│  RollBuilder ──► ACBuilder ──► AttackBuilder                │
│       │              │              │                       │
│       │              │              │                       │
│       └──────────────┼──────────────┘                       │
│                      │                                      │
│                      ▼                                      │
│              astFromRollConfigs()                           │
│                      │                                      │
│                      ▼                                      │
│              ExpressionNode (AST)                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    PMF Generation                           │
├─────────────────────────────────────────────────────────────┤
│  pmfFromRollBuilder()                                       │
│       │                                                     │
│       ├─ d20RollPMF() ──► PMF (for d20 rolls)               │
│       ├─ diePMF() ──────► PMF (for regular dice)            │
│       └─ combinePMFs() ─► PMF (convolve multiple PMFs)      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Query & Analysis                         │
├─────────────────────────────────────────────────────────────┤
│  DiceQuery                                                  │
│       │                                                     │
│       ├─ .mean() ────────────► Expected damage              │
│       ├─ .variance() ────────► Damage variance              │
│       ├─ .probAtLeastOne() ──► Hit/crit probabilities       │
│       ├─ .toChartSeries() ────► Chart data                  │
│       └─ .combined ───────────► Final PMF                   │
└─────────────────────────────────────────────────────────────┘
```

### PMF Data Structure

The `PMF` class is the core mathematical representation:

```
PMF
├── map: Map<number, Bin>
│   └── Bin
│       ├── p: number          (probability)
│       ├── count: {...}       (outcome counts: hit, crit, miss)
│       └── attr: {...}        (damage attribution)
├── epsilon: number            (probability threshold)
├── normalized: boolean        (whether PMF sums to 1.0)
└── identifier: string         (debug name, `pmf#…` from the content unless given; never a cache key)
```

The two entries (`@yipe/dice` and `@yipe/dice/builder`) share one `PMF` class, one `Mixture` class and one
set of error classes. A PMF made through either entry is an instance of the other's `PMF`, and a `Turn`
takes PMFs from either as attacks, riders and crit damage. `Mixture` is exported from both.

### Main Flow Example

Here's how a simple attack flows through the system:

```
1. User creates: d20.plus(5).ac(15).onHit(d6.plus(2))

2. Builder chain:
   RollBuilder(d20) 
     → plus(5) → RollBuilder(d20 + 5)
     → ac(15) → ACBuilder(d20 + 5 AC 15)
     → onHit(...) → AttackBuilder

3. AST generation:
   RollConfig[] → ExpressionNode
     - DieNode (d20)
     - ConstantNode (+5)
     - D20RollNode (AC check)
     - ConditionalNode (on hit)

4. PMF generation:
   AST → PMF operations
     - d20RollPMF(rollType, rerollOne) → PMF
     - Conditional application → PMF.branch()
     - Damage PMF → PMF
     - Combine → PMF (final result)

5. Query creation:
   AttackBuilder.toQuery() → DiceQuery
     - singles: [PMF]
     - combined: PMF (convolved)

6. Analysis:
   DiceQuery.mean() → 3.20 DPR
```
