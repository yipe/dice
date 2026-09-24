[![npm version](https://img.shields.io/npm/v/@yipe/dice.svg)](https://www.npmjs.com/package/@yipe/dice)
[![License: MIT](https://img.shields.io/badge/License-MIT-007ec6.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6?logo=typescript)
![Size](https://img.shields.io/bundlephobia/minzip/@yipe/dice?logo=npm&logoColor=fff&label=Size)
![Dice](https://dprcalc.com/api/roll.svg)

![Last Commit](https://img.shields.io/github/last-commit/yipe/dice?logo=github)
![Dependencies](https://img.shields.io/librariesio/release/npm/@yipe/dice?logo=npm)
[![GitHub issues](https://img.shields.io/github/issues/yipe/dice.svg?logo=github)](https://github.com/yipe/dice/issues)
[![Build Status](https://github.com/yipe/dice/actions/workflows/ci.yml/badge.svg)](https://github.com/yipe/dice/actions)
[![Tests](https://img.shields.io/badge/tests-passing-4c1.svg?logo=vitest&logoColor=white)](https://github.com/yipe/dice/actions/workflows/ci.yml)

# 🎲 @yipe/dice

A TypeScript library for **D&D 5e damage-per-round (DPR) calculations**, designed for players, Dungeon Masters, and developers who want to analyze combat mathematically.

This library powers [dprcalc.com](https://dprcalc.com) and provides a precise, composable way to model dice rolls, attacks, and outcomes with probability mass functions (PMFs) — not just averages. This allows for rich charting and statistics with full outcome attribution. It provides two main entry points: a fluent typescript interface or a dice expression string.

```ts
import { parse } from "@yipe/dice";

const attack = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
console.log("DPR:", attack.mean());

// or

const attack = d20.plus(8).ac(16).onHit(d8.plus(4));
console.log("DPR:", attack.mean());
```

## ✨ Features

- **D&D 5e Focused**: Designed around 5e rules (2014 and 2024).
- **Probability Mass Functions (PMF)**: Precise modeling of dice rolls and outcomes, not just averages.
- **Complex Attack Expressions**: Supports crit ranges, advantage/disadvantage, conditional damage, rerolls, minimum damage, and more.
- **Composable API**: Build dice expressions, run queries, and analyze results in just a few lines.
- **TypeScript First**: Full type safety and developer experience.

## 🚀 Quick Start

### Installation

```bash
# Install with npm or yarn
npm install @yipe/dice
# or
yarn add @yipe/dice
```

### Basic Usage

```ts
import { parse, DiceQuery } from "@yipe/dice";

const query = d20.plus(8).ac(16).onHit(d4.plus(4)).toQuery();

console.log("Hit chance:", query.probAtLeastOne(["hit", "crit"]));
console.log("Crit chance:", query.probAtLeastOne(["crit"]));
console.log("DPR:", query.mean());
```

**Output:**

```
Hit chance: 0.65
Crit chance: 0.05
DPR: 4.35
```

## 🛠 Development Setup

### Prerequisites

- **Node.js**: >= 18.17
- **Yarn**: 4.9.4 (specified in `packageManager`)

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/yipe/dice.git
cd dice

# Install dependencies
yarn install

# Build the project
yarn build

# Run tests
yarn test

# Run examples
yarn example
```

### Available Scripts

| Command | Purpose |
|---------|---------|
| `yarn build` | Compile TypeScript to JavaScript (outputs to `dist/`) |
| `yarn test` | Run test suite once |
| `yarn test:watch` | Run tests in watch mode |
| `yarn typecheck` | Type-check without emitting files |
| `yarn lint` | Run ESLint |
| `yarn example` | Run example scripts |

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

## 🏗 Architecture Overview

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
    │                                    ├─ .toQuery() ──► DiceQuery
    │                                    └─ .pmf ─────────► PMF
    │
    └─ .toPMF() ──► PMF
```

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
miss (the grammar reads left to right). `+` adds to every landed hit and crit, one whose payload
rolled 0 included, like the builder's `plus`: `(d20 + 5 AC 12) * (1d4 - 1) + 1d6` is
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

A parsed attack still differs from the builder in these cases:

- `parse()` has no natural-1 miss and no natural-20 hit: `(d20+30 AC 5) * (1d8)` means 4.725, the
  builder 4.5.
- A payload the doubling rewrite cannot read (`d4d6`, a nested check) is added to the crit as-is;
  the builder's `onHit` throws.
- A term joined by an op that also changes a miss (`~+`, `-`, `>`, `<`, `=`, `reroll`, `!`) loses
  the attack's crit and miss labels, so riders never see its crit. So do a clause after a trailing
  term (`… * (2d6) + 3 miss (1d6)`) and a repeat wrapper around an attack string
  (`2((d20 + 5 AC 15) * (2d6))`). An `&` there throws (see above).

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

**Strings from builders.** `toExpression()` prints a string that `parse()` reads back to the
builder's own distribution: a term after the first is parenthesised when it is an expression of its
own, `~+` joins a term to a running total that can be 0, and an attack always carries its crit clause
(`noCrit()` prints `xcrit0 (<hit payload>)`, which crits on no natural face). Explode, pool-wide explode, `scaleResult(…, "round")`,
fractional scale factors, `plusSeparateDamage()` and `halfOnMiss()` have no spelling and throw.
Strings have no natural-1 miss or natural-20 hit.

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
└── identifier: string         (cache key / debug name)
```

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

## 📦 Core Concepts

| Concept    | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| **PMF**    | Probability Mass Function. The core mathematical representation of outcomes. |
| **Query**  | Runs calculations and scenarios over one or more PMFs.                       |
| **Parser** | Parses text-based dice expressions like `(d20 + 8 AC 16) * (1d4 + 4)`.       |
| **Builder**| Fluent TypeScript API for building dice expressions.                         |
| **AST**    | Abstract Syntax Tree representing dice operations.                           |

## 🧙 Usage Examples

### Basic Attack

```ts
import { parse, DiceQuery } from "@yipe/dice";

const query = d20.plus(8).ac(16).onHit(d4.plus(4)).toQuery();

console.log("Hit chance:", query.probAtLeastOne(["hit", "crit"]));
console.log("Crit chance:", query.probAtLeastOne(["crit"]));
console.log("DPR:", query.mean());
```

### String Parser

```ts
import { parse } from "@yipe/dice";

const pmf = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
const query = new DiceQuery(pmf);

console.log("DPR:", query.mean());
```

#### Grammar

Spaces are ignored and letters may be any case. Every binary operator has the **same precedence and
associates left to right**: `1d6 + 2 * 3` is `(1d6 + 2) * 3`. Parenthesise to group.

| Syntax | Meaning |
| --- | --- |
| `7`, `d6`, `3d6`, `hd20` | A number, a die, a sum of dice, a die whose 1 is rerolled once (halfling luck, `d20 reroll 1`). |
| `N(X)`, `(X)d6` | N independent copies of X, summed. The count may be rolled: `(1d4)d6`. A count of 0 is 0 (`0d6`, `(1d4 - 1)d6` has P(0) = 1/4); a count that can be negative throws. |
| `NkhK(X)`, `NklK(X)` | The sum of the K highest (lowest) of N independent copies of X, exact for any X: `4kh3d6`, `2kl1(1d20)`, `4kh1(2d20)`. `2kl1(2d6)` keeps the lower of two 2d6 *sums*. |
| `X + Y` | Adds Y where the total so far is not 0, so a miss (0) stays 0. After an attack's payload it adds to every landed hit and crit, one that deals 0 included: `(d20 + 5 AC 15) * (1d4 - 1) + 1d6`. Inside a check total (left of `AC`/`DC`) `+` always adds, so `d20 - 5 + 1d4 AC 1` adds the d4 on a natural 5 too. |
| `X ~+ Y` | Always adds. |
| `X - Y`, `-X` | Subtracts. A leading `-` negates the argument after it, repeat included: `-2d6` is `-(2d6)`, `1d6 + -3` is `1d6 - 3`, `-1d8 + 1d6` has mean -1. There is no unary `+`. |
| `X * Y` | Y where X is not 0, else 0: the hit gate of `(check) * (damage)`. |
| `X ** Y` | The product. |
| `X / Y`, `X // Y` | Division rounding up, rounding down (toward -∞). A divisor that can be 0 throws. |
| `X > Y`, `X < Y` | The max, the min: `d20 > d20` is advantage, `3>d6` a floor of 3. |
| `X!` | The max of two independent copies of X. |
| `X = Y` | 1 where X equals Y, else 0. |
| `X & Y` | A mix weighted by each side's count of outcomes (see the refused shapes above). |
| `X reroll R` | Rolls X, and on a result in the face set R rolls X again and keeps the second roll. |
| `X AC T`, `X DC T` | An attack check (X where X ≥ T, else 0) and a saving throw (0 on a save, 1 on a failure). A total of exactly 0 that meets a T of 0 or less lands, though it reads 0 like a miss: `(d20 - 5 AC 0) * (1d6)` hits on a natural 5 and crits on a 20, like `d20.minus(5).ac(0).onHit(roll(1, d6))`. |
| `… crit (Y)`, `… xcritN (Y)`, `… miss (Y)`, `… save half`, `… pc` | Outcome clauses after an attack's or a save's payload. `xcrit0 (Y)` never crits: every landing is a hit. |

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
failed save `saveFail` (whatever the payload rolls, 0 included), a halved success `saveHalf`, and a
success with no `save half` `missNone`, like the builder's `onSaveFailure()`. A landed hit whose
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

### Damage Riders (Sneak Attack, Smite, Hunter's Mark)

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
| `onEveryHit` | once per attack that lands | Hunter's Mark, Hex, Rage |
| `otherwise` | when the rider before it did *not* | flurry of blows if you didn't smite |

#### Extra Attack

`attacks(count, source)` mirrors `roll(count, die)`, so the Fighter's four — or eight, with Action
Surge — stays one line:

```ts
const sword = d20.plus(9).ac(16).onHit(d6.plus(5));

turn().attacks(4, sword).onEveryHit(d6).mean(); // 35.0  — hunter's mark on each hit
turn().attacks(8, sword).onEveryHit(d6).mean(); // 70.0  — action surge
```

#### A rider can be anything that makes damage

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

#### The hard build

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

#### Asking questions

```ts
const t = turn([dagger, dagger]).onFirstHit(roll(3, d6));

t.mean();                                   // 18.6225
t.pmf.pAt(0);                               // 0.1225  — P(whiff)
t.pmf.stdev();                              // 8.8860
t.toQuery().probTotalAtLeast(20);           // 0.5062  — P(20+ damage)
t.toQuery().percentiles([0.25, 0.5, 0.75]); // [15, 20, 24]
```

#### Once per turn: keep the better damage roll

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

#### Conditions: advantage, disadvantage and crits granted by earlier attacks

The same verbs take a **grant** — a modifier with a lifetime — for the attack rolls after it:

```ts
import { advantage, disadvantage, turn } from "@yipe/dice/builder";

const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));

// A hit gives the next attack advantage. The next attack uses it up even on a miss, and passes it
// on if it lands.
turn([sword, sword]).onEveryHit(advantage().untilNextAttack()).mean();        // 12.202125
turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack()).mean(); // 19.192196

// A hit gives advantage for the rest of the turn if the target fails a save; each landing tries again.
turn([axe, axe]).onEveryHit(advantage().untilEndOfTurn(), { save: d20.plus(2).dc(15) });

// Once per turn, on the first hit, 40% of the time: advantage, and every later hit is a crit.
turn([fist, fist, fist]).onFirstHit(advantage().critOnHit().untilEndOfTurn(), { chance: 0.4 });

// One save, two grants: advantage for the melee attacks, disadvantage for the ranged ones.
turn().attack(axe, { tag: "melee" }).attack(bow, { tag: "ranged" })
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

#### Rerolls, sweeping AC, and naming attacks

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

#### Ids, errors, and plain data

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
`no-rebindable-source`, `unsupported-trigger`, `unsupported-policy`, `too-many-flags` — maps
straight onto a UI field state. A bad `of` fails at the call that introduced it, not later at
`.mean()`.

Each `onX` method takes an optional `{ id, of, critDamage }`, where `of` picks which attacks the
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

### Statistics and Charts

```ts
import { parse, DiceQuery } from "@yipe/dice";

const query = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").toQuery();
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

## 🧪 Running Examples

This repository includes example scripts:

```bash
yarn example basic
yarn example stats
yarn example turn
yarn example misc
```

Here is the basic example output:

```
% yarn example basic

┌────────────┐
│ Summary    │
├────────────┴─────────────────────────────────────────────┐
│ Expression:     (d20 + 5 AC 15) * (1d6+2) crit (2d6 + 2) │
│ Success Chance: 0.55                                     │
│ Expected DPR:   3.20                                     │
└──────────────────────────────────────────────────────────┘

┌────────────┐
│ PMF ()     │
├────────────┴───────────────────────────────────────────────────────────────────────────┐
│   0: █████████████████████████████████████████████████████████████████████████ 45.00%  │
│   3: █████████████▌                                                             8.33%  │
│   4: █████████████▋                                                             8.47%  │
│   5: █████████████▉                                                             8.61%  │
│   6: ██████████████▏                                                            8.75%  │
│   7: ██████████████▍                                                            8.89%  │
│   8: ██████████████▋                                                            9.03%  │
│   9: █▎                                                                         0.83%  │
│  10: █▏                                                                         0.69%  │
│  11: ▉                                                                          0.56%  │
│  12: ▋                                                                          0.42%  │
│  13: ▍                                                                          0.28%  │
│  14: ▏                                                                          0.14%  │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ CDF (): P(X ≤ x) │
├──────────────────┴─────────────────────────────────────────────────────────────────────┐
│   0: ████████████████████████████████▍                                         45.00%  │
│   1: ████████████████████████████████▍                                         45.00%  │
│   2: ████████████████████████████████▍                                         45.00%  │
│   3: ██████████████████████████████████████▍                                   53.33%  │
│   4: ████████████████████████████████████████████▌                             61.81%  │
│   5: ██████████████████████████████████████████████████▋                       70.42%  │
│   6: █████████████████████████████████████████████████████████▏                79.17%  │
│   7: ███████████████████████████████████████████████████████████████▍          88.06%  │
│   8: █████████████████████████████████████████████████████████████████████▉    97.08%  │
│   9: ██████████████████████████████████████████████████████████████████████▌   97.92%  │
│  10: ███████████████████████████████████████████████████████████████████████   98.61%  │
│  11: ███████████████████████████████████████████████████████████████████████▍  99.17%  │
│  12: ███████████████████████████████████████████████████████████████████████▋  99.58%  │
│  13: ███████████████████████████████████████████████████████████████████████▉  99.86%  │
│  14: ████████████████████████████████████████████████████████████████████████ 100.00%  │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ Outcome Table () │
├──────────────────┴───────────────────────────┐
│ DAMAGE │ PERCENT │ Crit % │  Hit % │  Miss % │
├────────┼─────────┼────────┼────────┼─────────┤
│ 0      │ 45.000% │ 0.000% │ 0.000% │ 45.000% │
│ 3      │  8.333% │ 0.000% │ 8.333% │  0.000% │
│ 4      │  8.472% │ 0.139% │ 8.333% │  0.000% │
│ 5      │  8.611% │ 0.278% │ 8.333% │  0.000% │
│ 6      │  8.750% │ 0.417% │ 8.333% │  0.000% │
│ 7      │  8.889% │ 0.556% │ 8.333% │  0.000% │
│ 8      │  9.028% │ 0.694% │ 8.333% │  0.000% │
│ 9      │  0.833% │ 0.833% │ 0.000% │  0.000% │
│ 10     │  0.694% │ 0.694% │ 0.000% │  0.000% │
│ 11     │  0.556% │ 0.556% │ 0.000% │  0.000% │
│ 12     │  0.417% │ 0.417% │ 0.000% │  0.000% │
│ 13     │  0.278% │ 0.278% │ 0.000% │  0.000% │
│ 14     │  0.139% │ 0.139% │ 0.000% │  0.000% │
└────────┴─────────┴────────┴────────┴─────────┘
```

This enables rich statistics like "how much damage comes from crits vs hits".

## 🧱 Roadmap

- [ ] Create a **web playground** with live examples
- [x] Higher-level `Turn` API for conditional damage riders (0.9.0)
- [ ] Add more comprehensive 5e rule examples
- [ ] Performance improvements for DPR-only calculations
- [ ] Multi-round and sustained vs nova simulations
- [ ] Deeper integration with [dprcalc.com](https://dprcalc.com)
- [ ] Blog posts and documentation
- [ ] Grammar refinements and new YACC parsing

## 💬 Discuss

Join our [Discord](https://dprcalc.com/discord) to discuss this library and more!

## 🤝 Contributing

Clone the repo and install dependencies:

```bash
git clone https://github.com/yipe/dice.git
cd dice
yarn install
```

Run tests:

```bash
yarn test
```

Run examples:

```bash
yarn example
```

## 📜 License

2025 MIT © [Michael Margolis](https://github.com/yipe)

## ⚖️ Legal / Trademarks

Wizards of the Coast, Dungeons & Dragons, and their logos are trademarks of Wizards of the Coast LLC in the United States and other countries.

© 2025 Wizards. All Rights Reserved.

## ❤️ Credits

Portions of this code are inspired by [dice.clockworkmod.com](https://github.com/koush/dice.clockworkmod.com) by Koushik Dutta (2013), licensed under the [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Initial [TypeScript port](https://github.com/loginName1/dice-calculator-ts) expertly created by [loginName1](https://github.com/loginName1).