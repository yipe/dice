# dice-node

napi-rs binding of the Rust port (`../dice`, crate `yipe-dice`) plus a TypeScript facade with the
public API of `@yipe/dice` (ADR-010). Phases 1-2: PMF, DiceQuery, parser, and the builders (RollBuilder family, ACBuilder, DCBuilder, AttackBuilder, SaveBuilder, turn effects, AST/expression/sample helpers). `src/turn/{turn,plan,readers,sample}.ts`, `Dice`, `common/bounce.ts` and `pmf/{mixture,sample,dense*}.ts` still run from `src/` over the facade.

## Build

```sh
bash rust/dice-node/build.sh   # cargo build --release, then copies the cdylib to rust/dice-node/dice.node
node -e 'console.log(require("./rust/dice-node/dice.node").parse("2d6+3", 0).mean())'
```

`dice.node` and `target/` are gitignored. No global tools needed beyond `cargo` (the crate links
`napi`, `napi-derive`, `napi-build` from crates.io).

## Layout

- `src/lib.rs`: `NativePmf`, `NativeQuery`, `parse`, `tryParse`, `withRollType`, `scaleParsedDice`.
  Bins cross as one JSON string; NaN, ±Infinity and -0 travel as the strings `"NaN"`, `"Infinity"`,
  `"-Infinity"`, `"-0"`. A Rust `Err(msg)` is a thrown `Error(msg)`.
- `ts/`: facade. `ts/<path>.ts` replaces `src/<path>.ts` (same exports). Files are verbatim TS copies where
  the Rust crate has no public equivalent yet (marked `verbatim from src/...`): `attributionByValue`,
  `damageAttributionChartModel`, `binTable`, `splitByFactor`, `mapValues`, `firstSuccessWeights`,
  and the `DiceQuery` tables/outcome ranges/`mapDamage`/`scaleDamage`.
  Constants, types, errors, the LRU cache, `Dice`, mixture, sample and dense kernels are used from `src/` as is.
  Caches live in Rust (`rust/dice/src/pmf/cache.rs`: pmf, parse, builder, single-die, d20-lift, roll, attack, missRerolled, DC, save; TS capacities and keys, `setCachingEnabled` toggle). A cached result keeps one JS object: `NativePmf.sharedId` is the address of the shared allocation and `PMF._wrapShared` maps it to a weakly held, lazily frozen wrapper.
- Native pieces: `src/{pmf,roll,roll_check,attack,save,effects,ast,conv,rng}.rs`. PMF bins cross as typed arrays (`NativeBins`); closures (rng, `withCheck`, `mapDamage`) are called synchronously through napi `Function`; `ts/native.ts` rethrows native errors as TS classes via `registerErrorMapper`.
- `vitest.rust.config.ts`: the repo's vitest config plus a plugin that redirects imports resolving to
  `src/<path>.ts` to `ts/<path>.ts` when it exists (not for test entry files, not for facade files).

## Run the TS tests against Rust

From the repo root:

```sh
yarn vitest run -c rust/dice-node/vitest.rust.config.ts tests/pmf.test.ts      # Rust engine
yarn vitest run tests/pmf.test.ts                                              # TS original
yarn vitest run -c rust/dice-node/vitest.rust.config.ts rust/dice-node/smoke.test.ts
```

`DICE_ENGINE=ts` with the Rust config runs the same suite on the TypeScript original (no redirect). A shadow mode (run both, compare) is not implemented.

## Drop-in package for dpr

```sh
bash rust/dice-node/build-pkg.sh [--rebuild-native]   # → rust/dice-node/pkg (ESM + CJS + .d.ts + dice.node)
bash rust/dice-node/dpr-swap.sh rust <dpr-worktree>   # node_modules/@yipe/dice → symlink to pkg (TS dist kept as dice.ts-dist)
bash rust/dice-node/dpr-swap.sh ts <dpr-worktree>     # back
```

`pkg/` bundles `src/{index,builder/index,dnd5e/index}.ts` with the same `src → ts/` redirect as the vitest
plugin; `dice.node` is found as `../dice.node` relative to the bundle files. `pkg/` is generated; `pkg/` is
gitignored (rebuild after any Rust or facade change). `dpr-swap.sh` probes which engine loads.

## Batch reads: `Turn.evaluateMany`
`Turn.evaluateMany(turns, request)` (ADR-018; `ts/turn/batch.ts`, `src/batch.rs`, Rust side `yipe_dice::turn::batch`) reads many turns in one native call and answers exactly what the single readers answer (bit for bit):
```ts
const outcomes = Turn.evaluateMany(turns, {
  mean: true, pmf: true,                       // turn.mean(), turn.pmf
  marginals: ["attack 1"], stepStats: ["attack 1"], fireProbability: ["sneak"], expectedApplications: ["sneak"],
  allMarginals: true, allStepStats: true, allLandings: true, peakStates: true, // every id of each turn (ids need not be shared)
  acs: [10, 12, 14],                           // turn.vsAC(ac) first; one reading per AC. Omit: read the turn as given.
  parallel: true,                              // default; false keeps everything on the JS thread
});
// outcomes[i]: { ok: true, readings: TurnReading[] } | { ok: false, error }  (the error the single reader throws)
```
- One failed reading fails its turn (`ok: false`), never the batch.
- Threading: turns holding no JS value run on rayon (the `parallel` cargo feature of `yipe-dice`, default on; off for wasm). A turn built from a JS callback or hand-written source (`failChance`, `{ rowCheck, under }`, `{ toPMF }`), or derived from one, is read on the JS thread, serially, after the others (a napi `Env` is JS-thread only); a JS throw aborts the batch and is rethrown unchanged.
- Wire: one `Float64Array` for the numbers, flat arrays for PMFs, marginals, step stats and landings, one `errors` array (see `src/batch.rs`).
- Use it for lists of independent turns whose reads are heavy (joint `pmf`/`mean` of turns with riders or conditions) or for AC sweeps of one turn. For a few tiny turns it buys nothing: the per-reader cost is in the engine and the PMF wrapping, not the crossing.
- Benchmark (build first, from the repo root): `npx tsx rust/dice-node/bench/batch.mjs` prints per-call TS, per-call Rust, `evaluateMany` serial and parallel at N = 100 and 1000 over AC 10..30, plus a dpr-shaped table, and checks every answer against the TS engine bit for bit.
