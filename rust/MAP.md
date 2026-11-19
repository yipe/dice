# Port map: @yipe/dice -> Rust

One Rust crate with the whole dice engine (`rust/dice`, crate `yipe-dice`) plus a Node binding
(`rust/dice-node`). Status and how to verify: `HANDOFF.md`. Decisions: `DECISIONS.md`. The planned
idiomatic Rust API: `API.md`.

## Units

| TS | Rust | Proof |
| --- | --- | --- |
| src/pmf/ | `rust/dice/src/pmf/` (PMF), `src/query/` (DiceQuery), dense kernel | 9,915 + 1,629 recorded calls, 565 + 28 synthetic, strict |
| src/parser/ | `rust/dice/src/parser/` | 11,262 cases (every test-file literal through parse/tryParse/withRollType/scaleParsedDice); depth cap 500 (ADR-016) |
| src/common/ | `rust/dice/src/common/` (bounce, errors, rng, caching flag) | 1,272 bounce cases |
| src/builder/ | `rust/dice/src/builder/` | translated TS tests + 44 golden chains |
| src/turn/ | `rust/dice/src/turn/` (plan, readers, turn, sample, batch) | `tests/compat/fixtures-0.16.json` replayed: 2,780/2,780 exact |
| src/dnd5e/ | `rust/dice/src/dnd5e/` | translated TS tests |
| src/index.ts, public TS API | `rust/dice-node/ts/` (facade over the napi binding) | the TS suite on the Rust engine: 6,323/6,345 |
| config/, explainer/, bench/ | out of scope | |

The TS tests are the spec: each Rust module carries its TS `it(...)` cases as `#[test]`s with the
same inputs and expected values. Functions as arguments (`withCheck(fn)`, `failChance`) are Rust
closures; in the binding they cross as napi callbacks.

## Known differences from the TS (beyond ADR-007/016/017)

- builder/expression.rs merge key: fields in canonical order; TS keys by object field order, so two
  equal configs whose `isSubtraction` and `pinned` fields were set in different orders merge in
  Rust but not in TS. No test reaches it.
- The binding's `inspectPlan` exposes ids only; an attached gate's `failChance` crosses as a JS
  index table (`ts/turn/effects.ts`).
