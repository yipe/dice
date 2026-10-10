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

**Exact D&D 5e damage math for TypeScript.**

Describe an attack, a spell, or a whole turn (Extra Attack, Sneak Attack, Divine Smite, Hunter's Mark,
advantage chained from a Vex weapon) and get back the complete damage distribution. It is not a
Monte Carlo simulation and it is not just an average: you get every possible damage total, its exact
probability, and which outcome (hit, crit, miss, failed save) produced it.

@yipe/dice is the engine behind **[dprcalc.com](https://dprcalc.com)**.

**[Build a turn in your browser at dprcalc.com/dice →](https://dprcalc.com/dice)**

```ts
import { d20, d4, d6, roll, turn } from "@yipe/dice/builder";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const rogue = turn([dagger, dagger]).onFirstHit(roll(3, d6)); // two-weapon fighting + Sneak Attack

rogue.mean();                              // 18.6225  damage per round
rogue.pmf.pAt(0);                          // 0.1225   chance the whole turn whiffs
rogue.toQuery().probTotalAtLeast(20);      // 0.5062   chance of 20+ damage
rogue.toQuery().percentiles([0.25, 0.5, 0.75]); // [15, 20, 24]
```

## Contents

- [Why @yipe/dice](#-why-yipedice)
- [Install](#-install)
- [Quick start](#-quick-start)
- [What it can do](#-what-it-can-do)
- [Dice expression cheat sheet](#-dice-expression-cheat-sheet)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)

## ✨ Why @yipe/dice

- **Exact.** Every number is computed analytically from the full probability distribution, never
  sampled.
- **Distributions, not averages.** Hit and crit chances, percentiles, P(at least N damage), variance,
  CDFs, and chart-ready series for any attack or turn.
- **Knows where the damage came from.** Each outcome is tagged `hit`, `crit`, `missNone`, `missDamage`,
  `saveFail` or `saveHalf`, so you can split damage into "from crits" and "from hits".
- **Whole turns, modeled jointly.** Riders like Sneak Attack and Smite depend on the attacks that
  trigger them. `turn()` gets the shape of the distribution right, not only the mean.
- **The 5e rules are built in.** Natural 1s miss, natural 20s crit and double the damage dice but not
  the modifiers. Also supported: advantage, disadvantage, Elven Accuracy, Halfling Luck, expanded crit
  ranges, saving throws for half damage, rerolls, minimum die values, keep-highest pools and
  exploding dice. Works for both 2014 and 2024 rules.
- **Two ways to write it.** A fluent, type-safe builder, or a compact dice string such as
  `(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)`. Each can be converted to the other.
- **TypeScript first, no runtime dependencies.** ESM and CommonJS builds with full type definitions.

## 📦 Install

```bash
npm install @yipe/dice
# or
yarn add @yipe/dice
# or
pnpm add @yipe/dice
```

Requires Node.js 18.17 or later. The package has two entry points:

| Import | Use it for |
| --- | --- |
| `@yipe/dice` | `parse()` for dice strings, `PMF`, `DiceQuery`, `withRollType()`, `tryParse()` and the error classes |
| `@yipe/dice/builder` | the fluent builder (`d20`, `d6`, `roll`, …), `turn()` and turn effects |

Both entries share the same `PMF` class, so you can mix values from either.

## 🚀 Quick start

The same attack, written both ways:

```ts
import { parse } from "@yipe/dice";
import { d20, d8 } from "@yipe/dice/builder";

// A dice string
parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)").mean(); // 5.75

// The fluent builder: +8 to hit against AC 16, 1d8 + 4 on a hit (crits are handled for you)
const longsword = d20.plus(8).ac(16).onHit(d8.plus(4));
longsword.mean();          // 5.75  expected damage per round
longsword.toExpression();  // "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"
```

## 🧙 What it can do

### Look past the average

`mean()` gives the DPR. `toQuery()` gives you everything else about the distribution:

```ts
const q = d20.plus(8).ac(16).onHit(d8.plus(4)).toQuery();

q.mean();                                // 5.75   expected damage
q.probAtLeastOne(["hit", "crit"]);       // 0.65   chance to land
q.probAtLeastOne("crit");                // 0.05   chance to crit
q.expectedDamageFrom("crit");            // 0.65   DPR contributed by crits
q.stdev();                               // 4.7342
q.probTotalAtLeast(10);                  // 0.2672 chance of 10+ damage
q.percentiles([0.25, 0.5, 0.75, 0.95]);  // [0, 6, 10, 12]
```

### Advantage, Elven Accuracy, Halfling Luck, crit ranges

```ts
import { d20, d8, hd20 } from "@yipe/dice/builder";

const hit = d8.plus(4);

d20.plus(8).ac(16).onHit(hit).mean();                     // 5.75
d20.withAdvantage().plus(8).ac(16).onHit(hit).mean();     // 7.8975
d20.withDisadvantage().plus(8).ac(16).onHit(hit).mean();  // 3.6025
d20.withElvenAccuracy().plus(8).ac(16).onHit(hit).mean(); // 8.7774
hd20.plus(8).ac(16).onHit(hit).mean();                    // 6.0375  Halfling Luck: reroll natural 1s
d20.plus(8).ac(16).critOn(19).onHit(hit).mean();          // 5.975   Champion: crit on 19-20
```

### Saving throws

```ts
// Fireball against a +2 save, DC 15: 8d6 on a failure, half on a success
const fireball = d20.plus(2).dc(15).onSaveFailure(roll(8, d6)).saveHalf();

fireball.mean();          // 22.3
fireball.toExpression();  // "(d20 + 2 DC 15) * (8d6) save half"
```

### Damage dice tricks

A plain roll exposes its distribution as `.pmf`:

```ts
roll(2, d6).pmf.mean();                   // 7
roll(2, d6).reroll(2).pmf.mean();         // 8.3333  Great Weapon Fighting (2014): reroll 1s and 2s
roll(2, d6).minimum(3).pmf.mean();        // 8       Great Weapon Fighting (2024): treat 1s and 2s as 3
roll(4, d6).keepHighest(4, 3).pmf.mean(); // 12.2446 4d6 drop lowest
d8.maxOf(2).pmf.mean();                   // 5.8125  roll twice, keep the higher
roll(8, d6).rerollUpTo(5).pmf.mean();     // 33.8853 Empowered Spell: reroll up to 5 dice
```

### Should I take the -5/+10?

Compare a Great Weapon Master power attack against a normal swing at every AC:

```ts
const greatsword = roll(2, d6).plus(5);

for (const ac of [13, 15, 17, 19]) {
  const normal = d20.plus(9).ac(ac).onHit(greatsword).mean();
  const power = d20.plus(4).ac(ac).onHit(greatsword.plus(10)).mean();
  console.log(`AC ${ac}: ${normal.toFixed(2)} vs ${power.toFixed(2)}`);
}
// AC 13: 10.55 vs 13.55
// AC 15: 9.35 vs 11.35
// AC 17: 8.15 vs 9.15
// AC 19: 6.95 vs 6.95   (break-even)
```

### Whole turns: Extra Attack, Sneak Attack, Smite, Hunter's Mark

A `turn()` combines attacks with **riders**, which are extra damage that depends on what the attacks
did. The library computes the exact joint distribution. If you computed Sneak Attack as a separate
distribution and added it to the attacks, the mean would come out right but the shape would be
wrong: the rogue above would show a 1.5% chance of a whiffed turn instead of the true 12.25%.

```ts
import { d20, d4, d6, d8, d10, roll, turn } from "@yipe/dice/builder";

const sword = d20.plus(9).ac(16).onHit(d6.plus(5));
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));

// Fighter: four attacks, Hunter's Mark on every hit
turn().attacks(4, sword).onEveryHit(d6).mean(); // 35

// Paladin/monk: smite on a crit, otherwise flurry of blows
const paladin = turn([dagger, dagger])
  .onAnyCrit(roll(2, d8), { id: "smite" })
  .otherwise([unarmed, unarmed]);
paladin.mean();                    // 19.5703
paladin.fireProbability("smite");  // 0.0975

// Everything at once
turn([dagger, dagger])
  .onFirstHit(roll(3, d6))       // Sneak Attack
  .onFirstHit(d10)               // a once-per-turn burn
  .onAnyCrit(roll(2, d8))        // Divine Smite on a crit
  .otherwise([unarmed, unarmed]) // flurry of blows if no smite
  .onEveryHit(d6)                // Hunter's Mark
  .mean();                       // 39.5903
```

| Rider | Fires | Example |
| --- | --- | --- |
| `onFirstHit` | once, on the first attack that lands (doubled if that attack crit) | Sneak Attack |
| `onAnyCrit` | once, if any attack crit | Divine Smite |
| `onEveryHit` | on every attack that lands, optionally `{ max: n }` times | Hunter's Mark, Rage, Superiority Dice |
| `onFirstMiss` / `onAnyMiss` | on a miss | rerolls such as Lucky |
| `otherwise` | when the rider before it did not fire | flurry if you didn't smite |

### Advantage that one attack gives to the next

Grants model effects such as Vex, Topple, Stunning Strike or a crit-on-hit condition. They apply
to later attack rolls, and the library tracks the turn order exactly:

```ts
import { advantage, critOnHit } from "@yipe/dice/builder";

const shortsword = d20.plus(8).ac(16).onHit(d6.plus(5));
const vex = shortsword.onEveryHit(advantage().untilNextAttack());

turn().attacks(4, shortsword).mean(); // 22.8
turn().attacks(4, vex).mean();        // 27.5867  each hit gives the next swing advantage

// Stunning Strike: on a failed save, advantage for the rest of the turn;
// on a successful save, advantage on the next attack only
const fist = d20.plus(8).ac(16).onHit(d6.plus(5));
turn([fist, fist, fist])
  .onFirstHit(advantage().untilEndOfTurn(), {
    save: d20.plus(2).dc(15),
    onSave: advantage().untilNextAttack(),
  })
  .mean(); // 19.7618  (17.1 without it)

// After the first hit, every later hit this turn is a crit
turn([shortsword, shortsword]).onFirstHit(critOnHit().untilEndOfTurn()).mean(); // 12.765
```

### Conditions: Prone, Stunned, Unconscious, grapples, curses

- `@yipe/dice/dnd5e` names the conditions; trigger verbs put them on the target behind a save, a chance or a contest, and `atStart` says what it already has, per creature. See the [guide](docs/guide.md#conditions-what-the-target-has-and-what-it-gets).

```ts
import { restrained } from "@yipe/dice/dnd5e";
const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
turn().attacks(2, sword).attack(sword, { target: "second" }).atStart(restrained()).mean(); // 21.545
```

### Once-per-turn rerolls such as Savage Attacker

```ts
import { keepBestDamage } from "@yipe/dice/builder";

const attack = d20.plus(5).ac(12).onHit(roll(2, d6).plus(3));

turn([attack, attack]).mean();                              // 14.7
turn([attack, attack]).onFirstHit(keepBestDamage()).mean(); // 15.9849
```

### Sweep a turn across armor classes

```ts
const base = turn([sword, sword]).onFirstHit(roll(3, d6));

[12, 14, 16, 18, 20].map((ac) => base.vsAC(ac).mean());
// [26.6225, 24.66, 22.4875, 20.105, 17.5125]
```

### Turns as plain data

Turns can be written as JSON-safe specs, which a UI can save and load as-is:

```ts
import { Turn } from "@yipe/dice/builder";

const fromUI = Turn.from({
  attacks: [{ id: "dagger 1", source: dagger }, { id: "dagger 2", source: dagger }],
  riders: [{ id: "sneak", damage: roll(3, d6), on: "first-hit" }],
});

fromUI.mean();                    // 18.6225
fromUI.fireProbability("sneak");  // 0.8775
```

Invalid specs throw a `TurnSpecError` right away. Its `code` (`unknown-id`, `cycle`, `duplicate-id`, …)
can be mapped directly to a form field error.

### Chart-ready output

```ts
import { parse } from "@yipe/dice";

const query = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").query();

query.toChartSeries();  // [{ x: 0, y: 0.35 }, { x: 5, y: 0.15 }, { x: 6, y: 0.153125 }, …]
query.toCCDFSeries();   // { support: [0, 1, …], data: [100, 65, …] }  P(damage ≥ x), in percent

rogue.toQuery().damageAttributionChartModel(); // stacked chart model: each total split by miss / hit / crit
```

### Forgiving parsing for UI input

```ts
import { tryParse, withRollType, DiceParseError, parse } from "@yipe/dice";

tryParse("2d6 + 3").mean(); // 10
tryParse("1d").mass();      // 0  (half-typed input returns an empty PMF instead of throwing)

withRollType("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)", "advantage");
// "(d20 > d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"

try {
  parse("d6@3");
} catch (err) {
  if (err instanceof DiceParseError) console.warn(`Bad dice expression: ${err.expression}`);
}
```

## 🎯 Dice expression cheat sheet

| Expression | Meaning |
| --- | --- |
| `(d20 + 7 AC 15) * (1d10 + 4) crit (2d10 + 4)` | an attack: to-hit vs AC, damage on a hit, damage on a crit |
| `… xcrit19 (2d10 + 4)` | crits on 19-20 |
| `… miss (4)` | damage on a miss |
| `(d20 + 5 DC 15) * (8d6) save half` | a saving throw for half damage |
| `d20 > d20` | advantage (the higher of the two) |
| `hd20` | Halfling Luck: rerolls a natural 1 |
| `4kh3d6` | 4d6, keep the highest 3 |
| `2(d6 reroll d2)` | 2d6, rerolling 1s and 2s on each die |
| `3 > d6` | a d6 that never rolls below 3 |
| `X & Y` | a weighted mix of two expressions |

All binary operators have the same precedence and associate left to right, so use parentheses to
group. The [full grammar](https://github.com/yipe/dice/blob/main/docs/guide.md#dice-expression-language) covers every operator and edge case.

## 📚 Documentation

- **[Guide and reference](https://github.com/yipe/dice/blob/main/docs/guide.md)**: the full grammar, crit and reroll rules, every `turn()` feature,
  statistics, and an architecture overview.
- **[Examples](examples)**: runnable scripts for attacks, statistics and turns.
- **[Changelog](CHANGELOG.md)**: what changed in each release.
- **[dprcalc.com/dice](https://dprcalc.com/dice)**: the library running in a real app.

Run the examples from a clone:

```bash
yarn example basic   # also: stats, turn, misc
```

```
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
```

## 💬 Community

Questions, ideas, or builds you want to model? Join the [Discord](https://dprcalc.com/discord) or
[open an issue](https://github.com/yipe/dice/issues).

## 🤝 Contributing

Contributions are welcome. You need Node.js 20 or later to run the tests (the published package
supports 18.17+) and Yarn 4 (via Corepack).

```bash
git clone https://github.com/yipe/dice.git
cd dice
yarn install
yarn test
```

| Command | Purpose |
| --- | --- |
| `yarn build` | Build ESM/CJS bundles and type definitions into `dist/` |
| `yarn test` | Run the test suite |
| `yarn test:watch` | Run tests in watch mode |
| `yarn typecheck` | Type-check without emitting |
| `yarn lint` | Run ESLint |
| `yarn example <name>` | Run an example script (`basic`, `stats`, `turn`, `misc`) |

Before you open a pull request, make sure `yarn typecheck`, `yarn lint` and `yarn test` pass, and add
an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any user-visible change. The
[architecture overview](https://github.com/yipe/dice/blob/main/docs/guide.md#architecture) explains how the code is organized.

## 📜 License

2026 MIT © [Michael Margolis](https://github.com/yipe)

## ⚖️ Legal / Trademarks

Wizards of the Coast, Dungeons & Dragons, and their logos are trademarks of Wizards of the Coast LLC in the United States and other countries.

© 2025 Wizards. All Rights Reserved.

## ❤️ Credits

Portions of this code are inspired by [dice.clockworkmod.com](https://github.com/koush/dice.clockworkmod.com) by Koushik Dutta (2013), licensed under the [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Initial [TypeScript port](https://github.com/loginName1/dice-calculator-ts) expertly created by [loginName1](https://github.com/loginName1).
