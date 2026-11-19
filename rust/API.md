# The Rust API (design, v3)

Status: design, not implemented. Same engine as today, so every number below is the TS
library's own (from its README and guide). The Rust surface does not mirror the TS API: it is
designed to read the way a player describes a turn, in ordinary Rust.

## Principles

1. **Notation where players have notation, Rust everywhere else.** Dice, attacks and saves are
   written the way a stat block writes them, inside three macros. Turns, targets and questions are
   plain Rust values and methods.
2. **The type is in the name.** `dice!` makes `Dice`, `attack!` makes `Attack`, `save!` makes `Save`.
3. **One way to do each thing.** No option objects, no string ids, no second builder.
4. **Errors in two places only.** A mistake inside a macro is a compile error pointing at the
   token. A turn that cannot be computed is the one `Result`, from `vs()`.
5. **Handles are plain `Copy` values.** Adding something to a turn returns an id you can keep,
   pass around and ask about, with no borrow of the turn.

## On one screen

```rust
use yipe_dice::prelude::*;

let dagger = attack!(+8 => 1d4 + 4);         // d20 + 8 to hit; a crit doubles the dice

let mut rogue = Turn::new();
rogue.add(vec![dagger; 2]);                  // two-weapon fighting
rogue.add(on_first_hit(dice!(3d6)));          // Sneak Attack

let dist = rogue.vs(16)?;                     // against AC 16: the only `?`
dist.mean();                                  // 18.6225
dist.p(0);                                    // 0.1225   the whole turn whiffs
dist.at_least(20);                            // 0.5062
dist.percentiles([25, 50, 75]);               // [15, 20, 24]
println!("{dist}");                           // summary: mean, P(0), percentiles, histogram
```

| You write | You get |
| --- | --- |
| `dice!(2d6 + 3)` | `Dice`: a roll |
| `attack!(+8 => 1d8 + 4)` | `Attack`: a to-hit roll and its damage |
| `save!(DC 15 Dex => 8d6 else half)` | `Save`: something the target rolls against |
| `Turn` | what you do, in order: attacks, saves, and riders on them |
| `Target` | what you do it to: AC, save bonuses, conditions it already has |
| `Dist` | the answer: every damage total with its exact probability |

## 1. `dice!`

| Write | Means |
| --- | --- |
| `d20`, `3d6`, `2d6 + 5`, `1d8 - 1` | dice and flat modifiers |
| `4d6kh3`, `2d20kl1` | keep the highest 3 / the lowest 1 |
| `2d6!` | exploding: a max face adds another die (exact: the cap is set so what's left is below 1e-12) |
| `2d6!2`, `8d6!p3` | exploding, at most 2 extra dice per die / 3 extra dice for the whole roll |
| `2d6 reroll <=2` | reroll a 1 or 2, once (Great Weapon Fighting 2014) |
| `2d6 min 3` | count any roll below 3 as 3 (Great Weapon Fighting 2024) |
| `8d6 reroll up to 5` | reroll up to five dice (Empowered Spell) |
| `{expr}` | a Rust value: `dice!({n}d6 + {mod})` |

```rust
dice!(2d6).mean();                  // 7
dice!(2d6 reroll <=2).mean();       // 8.3333
dice!(2d6 min 3).mean();            // 8
dice!(4d6kh3).mean();               // 12.2446
dice!(1d6!1).mean();                // 4.0833
dice!(2d6!p2).mean();               // 8.3287
let ui: Dice = "2d6! + 4".parse()?; // same grammar at run time (FromStr)
```

`Dice` has the arithmetic you expect: `dice!(1d8) + 4`, `2 * dice!(1d6)`, `dice!(1d8) + dice!(1d6)`.

## 2. `attack!`

`to-hit => damage on a hit`, an optional `else` for a miss, then optional clauses separated by commas. The d20 is implied.

```rust
attack!(+8 => 1d8 + 4)                          // a crit is 2d8 + 4
attack!(+8 adv => 1d8 + 4)                      // also: dis, elven (Elven Accuracy), lucky (Halfling)
attack!(+8 + 1d4 => 1d8 + 4)                    // Bless on the roll
attack!(+7 => 1d12 + 4, crit on 19)             // crits on 19-20
attack!(+7 => 1d12 + 4, crit 3d12 + 4)          // a crit that isn't "double the dice" (Brutal Critical)
attack!(+7 => 1d12 + 4 else 4)                  // damage on a miss: Graze (natural 1s included, never doubled)
attack!(+7 => 2d6! + 4)                         // exploding damage
attack!(+7 => 1d8 + 4, melee, finesse)          // reach and tags (for conditions and `of`)
attack!(+7 => 2d8 cold, ranged, spell)          // a damage type
attack!(+{prof + dex} => 1d8 + {dex})           // Rust values
```

Tags are a closed set the macro knows (`melee`, `ranged`, `finesse`, `light`, `heavy`, `thrown`,
`unarmed`, `weapon`, `spell`), so a typo is a compile error; anything else is `tag("..")`.

```rust
attack!(+7 => 1d12 + 4).vs(16).mean();          // 6.625
attack!(+7 => 1d12 + 4 else 4).vs(16).mean();   // 8.225   Graze adds 0.40 x 4
```

## 3. `save!`

`DC n Ability => damage on a failed save`, then `else` and what a success does (no `else`: nothing). The target supplies its bonus.

```rust
save!(DC 15 Dex => 8d6 else half)           // Fireball: half (rounded down) on a success, as the spell text says
save!(DC 13 Con => 3d6)                 // nothing on a success
save!(DC 15 Wis => 4d6 else 1d6)       // something else on a success

save!(DC 15 Dex => 8d6 else half).vs(Target::ac(10).dex(2)).mean();   // 22.3
```

## 4. `Target`

```rust
rogue.vs(16)?                                           // a number is an AC: +0 saves, no conditions
rogue.vs(Target::ac(16).con(2))?
rogue.vs(Target::ac(11).str(4).dex(-1).has(restrained()))?
rogue.vs(Target::ac(20).all_saves(7))?                  // a lich
```

Infallible setters on a small value, like `std::process::Command`. `From<i32>` makes a bare number an AC.

## 5. `Turn`

`t.add(..)` takes an attack, a save, a list of them, or a rider, and returns a `Copy` id for it.
Keep the id only when something else refers to it.

```rust
let sword   = attack!(+9 => 1d6 + 5);
let dagger  = attack!(+8 => 1d4 + 4);
let unarmed = attack!(+8 => 1d6 + 4);

// Fighter with Hunter's Mark
let mut t = Turn::new();
t.add(vec![sword; 4]);
t.add(on_every_hit(dice!(1d6)));
t.vs(16)?.mean();                                       // 35

// Paladin/monk: Divine Smite on a crit, otherwise Flurry of Blows
let mut t = Turn::new();
t.add(vec![dagger; 2]);
let smite = t.add(on_any_crit(dice!(2d8)));
t.add(otherwise(smite, vec![unarmed; 2]));
let dist = t.vs(16)?;
dist.mean();                                            // 19.5703
dist.fired(smite);                                      // 0.0975
```

### Riders

A rider is a trigger plus what happens:

| Trigger | Fires | For |
| --- | --- | --- |
| `on_first_hit(..)` | once, on the first landing (doubled if it crit) | Sneak Attack |
| `on_every_hit(..)` | on every landing | Hunter's Mark, Rage, Vex |
| `on_any_crit(..)`, `on_first_crit(..)` | on a crit | Divine Smite |
| `on_first_miss(..)`, `on_any_miss(..)` | on a miss | Lucky-style rerolls |
| `otherwise(rider, ..)` | when `rider` did not fire | Flurry if you didn't smite |

What happens can be dice (`dice!(1d6)`), a number (Rage: `on_every_hit(2)`), an attack or a list
of attacks (a bonus attack), a save (poison after a hit), a condition, or `KeepBestDamage`
(Savage Attacker). Where it applies is set on the rider:

```rust
t.add(on_every_hit(dice!(1d8)).at_most(2));             // Superiority Dice on at most 2 hits
t.add(on_first_hit(dice!(1d6)).of(Finesse));            // only finesse attacks count
t.add(on_every_hit(advantage(NextAttack)).of(swings));  // only these attacks (ids from `add`)
t.add(on_first_hit(dice!(1d6)).same_hit_as(sneak));     // the hit that carried another rider
t.add(on_first_hit(dice!(2d6)).when(SaveFails));        // a rider that watches a save
```

## 6. Conditions and advantage: effects that last

```rust
advantage(NextAttack)        disadvantage(EndOfTurn)      crit_on_hit(EndOfTurn)
prone(EndOfTurn)             stunned(EndOfTurn)           unconscious(UntilDamaged)
vulnerable(NextHit)          save_penalty(dice!(1d4), NextSave)
```

Whether the target gets a say is part of the effect, so it reads like the feature's text:

```rust
unconscious(UntilDamaged).unless_save(Con, 15)                          // Knock Out
advantage(EndOfTurn).unless_save(Con, 15).on_success(advantage(NextAttack))   // Stunning Strike
prone(EndOfTurn).unless_save(Con, 15).optional()                       // Topple, when it helps
prone(EndOfTurn).unless_contest(5, 7)                                   // 2014 shove: Athletics +5 vs +7
prone(EndOfTurn).with_chance(0.5)
```

A condition carries its 5e rule (Prone: advantage for `melee`, disadvantage for `ranged`).

```rust
let fist = attack!(+8 => 1d6 + 5, unarmed);

// Stunning Strike (README version): fail = advantage all turn, pass = the next attack only
let mut t = Turn::new();
t.add(vec![fist; 3]);
t.add(on_first_hit(advantage(EndOfTurn).unless_save(Con, 15).on_success(advantage(NextAttack))));
t.vs(Target::ac(16).con(2))?.mean();                    // 19.7618 (17.1 without)

// Vex: each hit with these swings gives the next attack advantage
let mut t = Turn::new();
let swings = t.add(vec![attack!(+8 => 1d6 + 5); 4]);
t.add(on_every_hit(advantage(NextAttack)).of(swings));
t.vs(16)?.mean();                                       // 27.5867 (22.8 without)

// Cunning Strike: the hit that carried Sneak Attack may knock the target out
let sword = attack!(+8 => 1d8 + 4, melee);
let mut t = Turn::new();
t.add(vec![sword.clone(); 3]);
let sneak = t.add(on_first_hit(dice!(3d6)));
t.add(on_first_hit(unconscious(UntilDamaged).unless_save(Con, 15)).same_hit_as(sneak));
t.vs(Target::ac(16).con(2))?.mean();                    // 32.0568

// The target starts Restrained
let mut t = Turn::new();
t.add(vec![sword; 2]);
t.vs(Target::ac(16).has(restrained()))?.mean();
```

## 7. `Dist`

```rust
dist.mean()   dist.stdev()   dist.p(0)   dist.at_least(20)   dist.at_most(5)
dist.percentiles([25, 50, 75])
dist.chance(Hit | Crit)          // outcomes are bitflags: Hit, Crit, Miss, MissDamage, SaveFail, SaveHalf
dist.damage_from(Crit)           // the part of the mean that came from crits
dist.fired(smite)   dist.times_fired(maneuvers)   dist.of(sneak)   dist.of(first_swing)
for (damage, p) in &dist { .. }  // the whole distribution
println!("{dist}")
```

## 8. Many targets at once

```rust
let means: Vec<f64> = t.vs_each([12, 14, 16, 18, 20])?.iter().map(Dist::mean).collect();
// [26.6225, 24.66, 22.4875, 20.105, 17.5125]   (evaluated in parallel)
```

## Decisions

| | Decision | Why |
| --- | --- | --- |
| Macros | three: `dice!`, `attack!`, `save!` | the type is in the name; errors point at the token |
| d20 | implied in `attack!` (`+8 =>`) and `save!` | it is always a d20 |
| Otherwise branch | `=> X else Y`: a save's success, an attack's miss (Graze); no `else` = nothing | `=>`/`else` read as a branch; one rule for both |
| AC | on the `Target`; `t.vs(16)` | the same turn against another creature is one change |
| Crit clauses | `crit on 19` (range), `crit 3d12 + 4` (damage) | `crit 19` was ambiguous |
| Exploding | `!`, `!2`, `!p3` | standard notation |
| Rerolls | `reroll <=2`, `min 3`, `reroll up to 5` | words over codes; reads like the feature |
| Graze | `else 4` | it is damage on a miss |
| Turn | `t.add(..)` returns `Copy` ids; `vec![attack; n]` for repeats (attacks are cheap `Clone`) | no borrow of the turn; dependencies by id, never by position or string |
| Riders | `on_first_hit(effect)` values, with `.of`, `.at_most`, `.same_hit_as`, `.when` | trigger and scope on the rider |
| Saves on effects | `effect.unless_save(Con, 15).on_success(..)` | the save belongs to the effect, as in the rules text |
| Target | `Target::ac(16).con(2)`, infallible setters, `From<i32>` | short, private fields can grow |
| Results | `Dist`, `&Dist: IntoIterator`, `Display` | iterate and print like any collection |
| Errors | compile time in macros; one `Result` from `vs()` | nothing else can fail |
| Fluent builder | internal (`pub(crate)`) | one way |
| Old strings | `Dice::from_ts("(d20 + 8 AC 16) * (1d8 + 4)")` | stored dprcalc expressions |
| serde | optional feature | turns as data when wanted |

## Open questions

Decided (2026-11-18):

1. **Typed splices.** `{n}` in a dice count is `u32`, a die's sides are a `Die` (non-zero), a
   modifier is `i32`: a bad spliced value cannot be written, so the macros stay infallible.
2. **Integer damage.** `Dist` keys on `i64`; `p(0)`, `at_least(20)`, `iter()` use integers.
   Probabilities stay `f64`. (The engine computes in `f64`; whole numbers are exact.)
3. **Several damage types per attack.** `attack!(+7 => 1d8 + 4 slashing + 1d6 fire)`, with:
   - `dealing(Fire)` conditions read each typed part ("did the hit deal fire?");
   - `dist.damage_from(Fire)`: exact mean by linearity; a fire-only `Dist` by evaluating the turn
     with the other types zeroed;
   - `Target::ac(16).resists(Fire)`, `.vulnerable(Cold)`, `.immune(Poison)`: each typed part is
     scaled (halved rounding down, doubled, zeroed) before the parts are summed, so the whole
     distribution is right, not just the mean.
   Engine work: attacks carry typed damage parts (today: one `typed()` per attack); stage 2b.

Before stage 2-3:

1. **Two creatures in one turn.** TS can aim an attack at a second creature
   (`attack(sword, { target: "second" })`), each with its own conditions. Proposal:
   `t.add(sword.at(second))` with `let second = t.creature(Target::ac(14))`.
2. **2014 vs 2024 rules.** Conditions, grapples and exhaustion differ by edition. Proposal: 2024 by
   default, `Turn::new().rules(Phb2014)` to switch.

Later:

3. Names for miss rerolls (Lucky, "the first miss hits instead"): `on_first_miss(reroll())`,
   `on_first_miss(hit_instead())`?
4. Rolling one play of a turn (TS `sample`): `t.roll(&mut rng)` behind a `rand` feature?
5. Chart output (TS chart model): `dist.chart()` returning plain series?
6. Crate name for crates.io (`yipe-dice`? `dnd-dice`?).

## Implementation stages (each checked against the engine's current numbers)

1. `dice!`, `attack!`, `save!` (proc-macro crate `yipe-dice-macros`), `Dice`/`Attack`/`Save`, `FromStr`, `from_ts`.
2. `Target`, `Turn::add`, ids, riders and triggers, `Dist` (integer damage).
   2b. Typed damage parts in the engine: per-type `dealing`, `damage_from(Type)`, resist/vulnerable/immune.
3. Conditions, `unless_save`/`unless_contest`/`with_chance`, `vs_each`.
4. README Rust section and `examples/` rewritten from this file, every number checked.
