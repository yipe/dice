# Rust port of @yipe/dice: status

> **Shelved, unmerged.** Tag `archive/rust-dice-2026-11`. A CPU profile of a dpr nova grind job
> showed `@yipe/dice` is 2.7% of worker CPU, so swapping in the Rust engine cannot speed the grind.
> The TS library stays the source of truth. Revive this if a Rust or wasm consumer appears; expect
> to re-record the fixtures against current TS `main` first.

Read `rust/MAP.md` (layout, known differences), `rust/DECISIONS.md` (ADRs) and `rust/API.md`
(the planned idiomatic Rust API) alongside this file.

## What is here

| Piece | State |
| --- | --- |
| `rust/dice` (`yipe-dice`): pmf, query, parser, builder, common, dnd5e, turn, caches | complete; 2,243 tests, bit-exact with TS (compat 2,780/2,780) |
| `rust/dice-node`: napi binding + TS facade (`ts/` mirrors `src/`), `Turn.evaluateMany` (rayon) | complete; the TS test suite on the Rust engine passes 6,323/6,345 (the 22 failures test TS internals) |
| dpr | 5 nova jobs on the Rust engine: result JSON identical to TS apart from wall time |
| `rust/API.md` | design only: `dice!`/`attack!`/`save!` macros, `Turn`, `Target`, `Dist` |

Speed (1,000 turns, all results identical to TS): heavy turns TS 2,683 ms vs Rust 1,643 ms per
call and 326 ms with parallel `evaluateMany`; dpr-shaped light reads TS 4.2 ms vs Rust 18.5 ms
(napi object creation per result dominates).

## How to verify (in `rust/dice`)

```sh
FIXTURE_STRICT=1 cargo test -q --release          # every suite; strict = no "not ported" todos
cargo clippy --all-targets -- -D warnings
cargo run -q --release --example readme           # the README's Rust section, printed
```

Gitignored fixtures must be regenerated in a fresh checkout (from the repo root, ~1 min):

```sh
yarn install
yarn vitest run -c rust/dice/fixtures/vitest.record.config.ts && node rust/dice/fixtures/merge.mjs
cd rust/dice/fixtures && grep '"op":"DiceQuery\.' recorded.jsonl > recorded-query.jsonl \
  && grep -v '"op":"DiceQuery\.' recorded.jsonl > r.tmp && mv r.tmp recorded.jsonl && cd -
npx -y tsx rust/dice/fixtures/gen-parser.mts      # fixtures/parser.jsonl
npx -y tsx rust/dice/fixtures/gen-bounce.mts      # fixtures/bounce.jsonl (from bounce-inputs.jsonl)
```

The TS suite on the Rust engine: `bash rust/dice-node/build.sh && yarn vitest run -c rust/dice-node/vitest.rust.config.ts`.
dpr drop-in: `bash rust/dice-node/build-pkg.sh`, then `rust/dice-node/dpr-swap.sh rust|ts <dpr checkout>`.

## Porting rules that held up

- A mismatch with a recorded TS value is a port bug; never edit fixtures or widen tolerances.
- JS semantics to watch: `Math.round` rounds .5 toward +inf, NaN through `Math.max/min`, `{}` vs
  `undefined`, thrown errors become `Err` with the exact message, UTF-16 string indexes, insertion
  order (IndexMap) for JS `Map`/object iteration, JS `\s`.
- Share, don't clone: the TS shares one PMF object across caches and turns; the Rust port only got
  fast once it shared `Arc<Pmf>` the same way (per-PMF memos were cold otherwise).

## Next, if revived

1. Implement `rust/API.md` in its stages (macros first), each example checked against the engine.
2. Typed damage parts in the engine (several damage types per attack, per-type resistance).
3. wasm build over the same facade, for the browser.
