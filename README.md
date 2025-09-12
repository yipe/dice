[![npm version](https://img.shields.io/npm/v/@yipe/dice.svg)](https://www.npmjs.com/package/@dpr/dice)
[![License: MIT](https://img.shields.io/badge/License-MIT-007ec6.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6?logo=typescript)
![Dice Roll](https://img.shields.io/badge/Dice-20%20sided-007ec6?logo=dungeonsanddragons)

[![GitHub issues](https://img.shields.io/github/issues/yipe/dice.svg)](https://github.com/yipe/dice/issues)
[![Build Status](https://github.com/yipe/dice/actions/workflows/ci.yml/badge.svg)](https://github.com/yipe/dice/actions)
[![Tests](https://img.shields.io/github/actions/workflow/status/yipe/dice/ci.yml?label=tests)](https://github.com/yipe/dice/actions/workflows/ci.yml)

# 🎲 @dpr/dice

A TypeScript library for **D&D 5e damage-per-round (DPR) calculations**, designed for players, Dungeon Masters, and developers who want to analyze combat mathematically.

This library powers [dprcalc.com](https://dprcalc.com) and provides a precise, composable way to model dice rolls, attacks, and outcomes with probability mass functions (PMFs) — not just averages. This allows for rich charting and statistics with full outcome attribution.

```ts
import { parse } from "@dpr/dice";

const attack = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
console.log("DPR:", attack.mean());
```

## ✨ Features

- **D&D 5e Focused**: Designed around 5e rules (2014 and 2024).
- **Probability Mass Functions (PMF)**: Precise modeling of dice rolls and outcomes, not just averages.
- **Complex Attack Expressions**: Supports crit ranges, advantage/disadvantage, conditional damage, rerolls, minimum damage, and more.
- **Composable API**: Build dice expressions, run queries, and analyze results in just a few lines.
- **TypeScript First**: Full type safety and developer experience.

## 🚀 Installation

(COMING SOON!)

```bash
# Install with npm or yarn
npm install @dpr/dice
# or
yarn add @dpr/dice
```

## 📦 Core Concepts

| Concept    | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| **PMF**    | Probability Mass Function. The core mathematical representation of outcomes. |
| **Query**  | Runs calculations and scenarios over one or more PMFs.                       |
| **Parser** | Parses text-based dice expressions like `(d20 + 8 AC 16) * (1d4 + 4)`.       |
| **Dice**   | Represents the outcome of a single dice expression                           |

## 🧙 Basic Usage

Here's a simple example of calculating damage for a basic attack:

```ts
import { parse, DiceQuery } from "@dpr/dice";

const query = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").toQuery();

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

## ⚔️ Sneak Attack Example

Conditional damage ("once-per-turn damage riders") like Sneak Attack can be modeled easily:

```ts
import { parse, DiceQuery } from "@dpr/dice";

function damageRiderExample() {
  const attack = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)");
  const sneakAttack = parse("3d6");
  const sneakAttackCrit = parse("6d6");

  // Determine the probability of a success (hit or crit) and a crit
  const attacks = new DiceQuery([attack, attack]);
  const [pSuccess, pCrit] = attacks.firstSuccessSplit(
    ["hit", "crit"],
    ["crit"]
  );

  // Calculate the expected damage of sneak attack in both scenarios
  const sneak = PMF.exclusive([
    [sneakAttack, pSuccess],
    [sneakAttackCrit, pCrit],
  ]);

  // Create a full round with all of those damage outcomes

  const fullRound = new DiceQuery([attack, attack, sneak]);
  const DPR = fullRound.mean();

  console.log("full round DPR", DPR);

  // Congrats, you can now chart and query this round!
  return fullRound;
}
```

## 📊 Statistics and Charts

You can generate full statistical distributions for visualization or reporting.

```ts
import { parse, DiceQuery } from "@dpr/dice";

const query2 = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").toQuery();
console.table(query2.toChartSeries());
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

## 🗂 Project Structure

| File        | Purpose                               |
| ----------- | ------------------------------------- |
| `src/`      | Core Dice class and logic             |
| `examples/` | Example scripts showing library usage |
| `tests/`    | Comprehensive library tests           |

## 🧪 Running Examples

This repository includes example scripts.

```bash
yarn example basic
yarn example stats
yarn example sneakattack
yarn example misc
```

Here is the basic example:

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

## 🎲 Sample Dice Expression Grammar

## 🧱 Roadmap

- [ ] **Publish** to npm as `@dpr/dice`
- [ ] Create a **web playground** with live examples
- [ ] Consider creating higher-level APIs: `Turn`, `Attack`, `DamageRider`
- [ ] Simplify and improve PMF and Query interface ergonomics
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

Run tests

```bash
yarn test
```

Run examples

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

```

```
