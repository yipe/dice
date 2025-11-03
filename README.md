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

### Sneak Attack (Conditional Damage)

Conditional damage ("once-per-turn damage riders") like Sneak Attack can be modeled easily:

```ts
import { DiceQuery, PMF, roll } from "@yipe/dice";

function sneakAttack() {
  const attackPMF = d20.plus(8).ac(16).onHit(d4.plus(4)).pmf;
  const sneakAttack = roll(3, d6);
  const attacks = new DiceQuery([attackPMF, attackPMF]);
  const [pHit, pCrit] = attacks.firstSuccessSplit(onAnyHit, onCritOnly);
  const sneakPMF = PMF.exclusive([
    [sneakAttack.pmf, pHit],
    [sneakAttack.doubleDice().pmf, pCrit],
  ]);

  return new DiceQuery([attackPMF, attackPMF, sneakPMF]);
}

console.log("DPR with once-per-turn sneak attack: ", sneakAttack().mean());
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

## 🧪 Running Examples

This repository includes example scripts:

```bash
yarn example basic
yarn example stats
yarn example sneakattack
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
- [ ] Consider creating higher-level APIs: `Turn`, `Attack`, `DamageRider`
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