[![License: MIT](https://img.shields.io/badge/License-MIT-007ec6.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-2024-dea584?logo=rust)
![Dice](https://dprcalc.com/api/roll.svg)
![Last Commit](https://img.shields.io/github/last-commit/yipe/dice/rust-dice?logo=github)
[![GitHub issues](https://img.shields.io/github/issues/yipe/dice.svg?logo=github)](https://github.com/yipe/dice/issues)

# 🎲🦀 yipe-dice

**Exact D&D 5e damage math for Rust. Write the dice the way the stat block does.**

```rust
use yipe_dice::prelude::*;

fn main() -> Result<(), DiceError> {
    let dagger = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)")?;

    let rogue = Turn::new()?
        .attacks(2, dagger)?             // two-weapon fighting
        .on_first_hit(roll(3, d6())?)?;  // Sneak Attack, doubled on a crit

    rogue.mean()?;                                      // 18.6225  damage per round
    rogue.pmf()?.p_at(0);                               // 0.1225   the whole turn whiffs
    rogue.to_query()?.prob_total_at_least(20);          // 0.5062   20+ damage
    rogue.to_query()?.percentiles(&[0.25, 0.5, 0.75]);  // [15.0, 20.0, 24.0]
    Ok(())
}
```

Describe an attack, a spell, or a whole turn and get back the complete damage distribution. It is not
a Monte Carlo simulation and it is not just an average: every possible damage total, its exact
probability, and which outcome (hit, crit, miss, failed save) produced it.

This is the Rust port of [`@yipe/dice`](https://www.npmjs.com/package/@yipe/dice), the engine behind
**[dprcalc.com](https://dprcalc.com)**. It is bit-exact with the TypeScript library: its tests replay
recorded TypeScript calls and get the same numbers.

## Contents

- [Dice strings](#-dice-strings)
- [Strings and builders are one language](#-strings-and-builders-are-one-language)
- [Look past the average](#-look-past-the-average)
- [Whole turns](#-whole-turns)
- [Install](#-install)
- [Status and verification](#-status-and-verification)

## 🎯 Dice strings

`parse` reads the same notation dprcalc.com uses and returns the exact distribution (a `Pmf`):

```rust
let longsword = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)")?;

longsword.mean();   // 5.75    damage per swing
longsword.p_at(0);  // 0.35    chance of a miss
longsword.stdev();  // 4.7342
```

| `parse(…)` | Means | `.mean()` |
| --- | --- | --- |
| `2d6 + 3` | dice and modifiers | 10 |
| `4kh3d6` | 4d6, keep the highest 3 | 12.2446 |
| `2(d6 reroll d2)` | Great Weapon Fighting (2014): reroll 1s and 2s on each die | 8.3333 |
| `2(3 > d6)` | Great Weapon Fighting (2024): a d6 that never rolls below 3 | 8 |
| `d8 > d8` | roll twice, keep the higher | 5.8125 |
| `(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)` | an attack: to-hit vs AC, damage on a hit, damage on a crit | 5.75 |
| `(d20 > d20 + 8 AC 16) * …` | with advantage | 7.8975 |
| `(d20 < d20 + 8 AC 16) * …` | with disadvantage | 3.6025 |
| `(hd20 + 8 AC 16) * …` | Halfling Luck: a natural 1 is rerolled | 6.0375 |
| `… xcrit2 (2d8 + 4)` | crits on the top 2 faces (19-20) | 5.975 |
| `… crit (2d8 + 4) miss (4)` | 4 damage on a miss (Graze) | 7.15 |
| `(d20 + 2 DC 15) * (8d6) save half` | Fireball vs a +2 save, half on a success | 22.3 |

Natural 1s miss, natural 20s crit, and `crit` is written out, so the notation says exactly what a crit
deals. All binary operators share one precedence and associate left to right: use parentheses to
group. `X + Y` leaves a 0 alone (a miss stays a miss); `X ~+ Y` always adds. The
[full grammar](docs/guide.md#dice-expression-language) covers every operator.

Strings typed by a user:

```rust
use yipe_dice::parser::{try_parse, with_roll_type};

with_roll_type("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", "advantage")?;
// "(d20 > d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"

try_parse("1d")?.mass();  // 0.0  half-typed input is an empty Pmf, not an error

parse("d6@3").unwrap_err().to_string();
// "Unexpected token: '@' from expression: 'd6@3'"
```

## 🔁 Strings and builders are one language

Every builder prints the string it stands for, and that string parses back to the same numbers:

```rust
let longsword = d20().plus(8)?.ac(16)?.on_hit(d8().plus(4)?)?;
longsword.to_expression()?;  // "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"
longsword.mean()?;           // 5.75

d20().with_advantage()?.plus(8)?.ac(16)?.on_hit(d8().plus(4)?)?.to_expression()?;
// "(d20 > d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"

d20().plus(8)?.ac(16)?.crit_on(19)?.on_hit(d8().plus(4)?)?.to_expression()?;
// "(d20 + 8 AC 16) * (1d8 + 4) xcrit2 (2d8 + 4)"

roll(4, d6())?.keep_highest(4, 3)?.to_expression()?;  // "4kh3(1d6)"
roll(2, d6())?.reroll(2)?.to_expression()?;           // "2(d6 reroll d2)"

d20().plus(2)?.dc(15)?.on_save_failure(roll(8, d6())?)?.save_half()?.to_expression()?;
// "(d20 + 2 DC 15) * (8d6) save half"
```

Builders are immutable and return `Result<_, DiceError>` where they can fail, so chain with `?`.
Numbers are any integer or float (`plus(8)`, `ac(16)`). Calls with options have a `_with` twin
(`attacks_with`, `on_any_crit_with`, `parse_with`, `to_query_with`).

## 🔍 Look past the average

```rust
let q = longsword.to_query()?;

q.prob_at_least_one(["hit", "crit"]);     // 0.65  chance to land
q.prob_at_least_one("crit");              // 0.05
q.expected_damage_from("crit");           // 0.65  of the 5.75, what crits contribute
q.prob_total_at_least(10);                // 0.2672
q.percentiles(&[0.25, 0.5, 0.75, 0.95]);  // [0.0, 6.0, 10.0, 12.0]
```

Every outcome is tagged `hit`, `crit`, `missNone`, `missDamage`, `saveFail` or `saveHalf`, so damage
splits cleanly into "from crits" and "from hits".

## ⚔️ Whole turns

A `Turn` takes attacks (a parsed string or a builder) and **riders**: extra damage that depends on
what the attacks did. The turn is computed jointly, so the whole shape of the distribution is right,
not only the mean.

```rust
// Fighter: four attacks, Hunter's Mark on every hit
let sword = parse("(d20 + 9 AC 16) * (1d6 + 5) crit (2d6 + 5)")?;
Turn::new()?.attacks(4, sword)?.on_every_hit(d6())?.mean()?;  // 35.0

// Paladin/monk: Divine Smite on a crit, otherwise a flurry of blows
let dagger = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)")?;
let unarmed = parse("(d20 + 8 AC 16) * (1d6 + 4) crit (2d6 + 4)")?;
let smite = ConditionOptions {
    rider: RiderOptions { id: Some("smite".into()), ..RiderOptions::default() },
    ..ConditionOptions::default()
};
let paladin = Turn::new()?
    .attacks(2, dagger)?
    .on_any_crit_with(roll(2, d8())?, smite)?
    .otherwise(vec![DamageSource::from(unarmed.clone()), DamageSource::from(unarmed)])?;
paladin.mean()?;                     // 19.5703
paladin.fire_probability("smite")?;  // 0.0975

// Vex: each hit gives the next swing advantage
let shortsword = d20().plus(8)?.ac(16)?.on_hit(d6().plus(5)?)?;
let vex = shortsword.on_every_hit(advantage().until_next_attack())?;
Turn::new()?.attacks(4, vex)?.mean()?;  // 27.5867  (22.8 without Vex)
```

| Rider | Fires | Example |
| --- | --- | --- |
| `on_first_hit` | once, on the first attack that lands | Sneak Attack |
| `on_any_crit` | once, if any attack crits | Divine Smite |
| `on_every_hit` | on every attack that lands | Hunter's Mark, Rage |
| `otherwise` | when the rider before it did not fire | flurry if you didn't smite |

Give a rider's dice as a builder (`roll(3, d6())`, `d6()`) so a crit doubles them. A parsed `"1d6"`
is a finished distribution and is not doubled: the fighter above would deal 34.3, not 35.

Sweep a turn across armor classes with `vs_ac`. It rebinds the AC of builder attacks; a parsed
attack has its AC baked into the string, so use the builder here:

```rust
let sword = d20().plus(9)?.ac(16)?.on_hit(d6().plus(5)?)?;
let base = Turn::new()?.attacks(2, sword)?.on_first_hit(roll(3, d6())?)?;

for ac in [12, 14, 16, 18, 20] {
    base.vs_ac(ac)?.mean()?;  // 26.6225, 24.66, 22.4875, 20.105, 17.5125
}
```

## 📦 Install

```toml
[dependencies]
yipe-dice = { git = "https://github.com/yipe/dice", branch = "rust-dice", package = "yipe-dice" }
```

`use yipe_dice::prelude::*;` brings in `parse`, the builders (`d20`, `d6`, `roll`, …), `Turn`,
`Pmf`, `DiceQuery` and `DiceError`. The default `parallel` feature runs batch evaluation on rayon;
turn it off for wasm.

## ✅ Status and verification

The port is complete and shelved, not merged into `main`: see [`rust/HANDOFF.md`](rust/HANDOFF.md).
The crate lives in [`rust/dice`](rust/dice); [`rust/API.md`](rust/API.md) sketches a more idiomatic
API (`dice!`/`attack!`/`save!` macros) that is designed but not implemented.

Every number in this README is asserted by [`rust/dice/examples/readme.rs`](rust/dice/examples/readme.rs):

```sh
cd rust/dice
cargo run -q --release --example readme  # every README number, checked
FIXTURE_STRICT=1 cargo test -q --release  # the full suite (fixtures: see rust/HANDOFF.md)
```

## 📜 License

2026 MIT © [Michael Margolis](https://github.com/yipe)

## ⚖️ Legal / Trademarks

Wizards of the Coast, Dungeons & Dragons, and their logos are trademarks of Wizards of the Coast LLC in the United States and other countries.

© 2025 Wizards. All Rights Reserved.

## ❤️ Credits

Portions of this code are inspired by [dice.clockworkmod.com](https://github.com/koush/dice.clockworkmod.com) by Koushik Dutta (2013), licensed under the [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Initial [TypeScript port](https://github.com/loginName1/dice-calculator-ts) expertly created by [loginName1](https://github.com/loginName1).
