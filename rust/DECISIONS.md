# Decisions

## ADR-001: Shape is a library
Status: accepted (2026-11-17)
Context: `analyze --whole-app` guessed "server" from `explainer/scripts/smoke.mjs`; the package `@yipe/dice` has no `main` and no server. `explainer/` is a UI (stays TypeScript).
Decision: Port `@yipe/dice` as a library. No `app record`; each unit's `record` cases are the proof. `explainer/` is out of scope.
Consequences: front door is a library crate (`app front-door --library`).

## ADR-002: Primary consumer is the DPR grind (~/src/dpr)
Status: accepted (2026-11-17)
Context: The grind (`api/admin/optimizer-run.ts`, `@yipe/synthetic` `optimizeSelection*` -> `dprFor` -> `@yipe/dice`) evaluates millions of turns. Profiling `bench/scenarios.ts` shows the hot code is `src/turn/` and `src/pmf/`. Per-leaf-function wasm ports lose to V8 (crossing ~0.4us; see `rust/common-rs` bench).
Decision: Speed comes from porting whole call chains so one crossing does a whole turn evaluation, and from Rust-side batching. Leaf ports are never shipped alone.
Consequences: `common-rs` and `dnd5e-rs` are proof-of-loop crates, to be folded into the final crate.

## ADR-003: Wasm first, native (napi) later
Status: accepted (2026-11-17)
Context: The grind and dprcalc.com both load the package through JS.
Decision: wasm-bindgen is the bridge. A native napi build and a browser target come after the core is ported.
Consequences: no threads in wasm by default; parallel batching is a later decision (wasm threads or native rayon).

## ADR-004: Full fluent builder is in scope
Status: accepted (2026-11-17)
Context: The fluent API (`d20.plus(8).ac(16).onHit(...)`) and effects with closures (`GrantSaveSpec.failChance` is a function of context) cannot cross a wasm boundary as data. Chatty per-method calls across the boundary would be slower than the TS.
Decision: The Rust crate implements the builder and turn engine natively. The JS-facing surface is a coarse one: build-and-evaluate from a serialized spec (the library already has JSON-safe forms, e.g. `Turn.onEveryHit`), plus a TS facade that records the fluent calls into a spec and sends it once at `toPMF()`/query time. Closure-valued fields need a data form (open question Q-1).
Consequences: Callers (`@yipe/ddb`, `@yipe/synthetic`) keep the fluent API unchanged.

## ADR-005: Float equivalence bar is 1e-9
Status: accepted (2026-11-17)
Decision: `record --float-tolerance 1e-9` for numeric units. Integers, strings and structure must match exactly. Where cheap, keep bit-identical anyway.
Consequences: Rust may use dense arrays and different summation order.

## ADR-007: Recording harness may cap absurd sizes
Status: accepted (2026-11-17)
Context: The original aborts node (OOM) on sizes like 2^31 dice/faces; `record` cannot survive that.
Decision: A `guard.mjs` per crate rejects sizes above 10000 with a RangeError; the port does the same.

## ADR-009: Port the dice library as a hand-written pure Rust crate
Status: accepted (2026-11-17)
Context: The grind profile (rogue thief: dice 42%, ddb 41%; others under 20%) shows the port will not speed the grind much; a Rust library is still worth having. The core types (`PMF`, `DiceQuery`, builder, turn) are classes with rich APIs, so a generated binding layer does not fit them.
Decision: `rust/dice` (crate `yipe-dice`) is a plain Rust library, no bindings yet. Proof is `fixtures/gen.mts`, which runs the TypeScript original and writes `fixtures/cases.jsonl`; `tests/fixtures.rs` replays it (1e-9, ADR-005). Port order: pmf, then parser, then builder+turn+dnd5e as one piece; `common-rs`/`dnd5e-rs` fold in later. Bindings (wasm, napi) come after the core passes.
Consequences: New behavior is covered by adding cases to gen.mts and regenerating. Damage keys are `i64` (all recorded supports are integers); revisit if a fixture shows a fractional key. JS number-to-string is `js::num_to_string`, never `format!("{}")`.

## ADR-010: Rust becomes the source of truth
Status: accepted (2026-11-17)
Context: The engine changes weekly through the grind's fix loop; two maintained copies would drift.
Decision: Once the Rust core passes every fixture, `@yipe/dice` becomes a thin TypeScript wrapper over the Rust build (wasm for the browser, napi for Node), keeping its public API. Engine fixes land in Rust only after cutover.
Consequences: Until cutover the TypeScript stays primary and the Rust follows it via fixtures. Cutover needs the fluent API facade (ADR-004, Q-1) and a published wasm/napi package. Fixtures stay as regression tests after cutover.

## ADR-011: Porting rule: no lint silencing beyond NaN guards
Status: accepted (2026-11-17)
Context: PmfOutcomes added `#[allow(dead_code)]` and `#[doc(hidden)]` to a public method to quiet a warning that did not exist.
Decision: A port may add only `#[allow(clippy::neg_cmp_op_on_partial_ord)]`, on a `!(x > y)` that mirrors a TS NaN guard, with a comment. Any other allow or `doc(hidden)` goes back to Opus.

## ADR-012: Damage keys are f64 with JS Map semantics; the test suite is the main fixture source
Status: accepted (2026-11-17)
Context: Calls recorded from the repo's own 6,310 tests have fractional damage keys (17.875, 44.625: half damage, `scaleDamage`); synthetic fixtures never did. They also showed `toJSON()` drops `epsilon`, which changes `power`/`convolve` results.
Decision: Keys are `Damage(f64)` (src/damage.rs): SameValueZero equality, numeric order. `fixtures/record-pmf.ts` wraps PMF methods during `vitest run` and records outermost calls (with `epsilon`) to `fixtures/recorded.jsonl`; `tests/recorded.rs` replays them. `gen.mts`/`tests/fixtures.rs` stay for hand-picked edge cases. recorded.jsonl (70 MB) is gitignored and regenerated (see rust/dice/.gitignore).
Consequences: Every later unit (DiceQuery, parser, builder, turn) gets a recorder over its public methods first; synthetic inputs alone miss real shapes.

## ADR-014: Porting rule: a mismatch is a port bug until git says otherwise
Status: accepted (2026-11-17)
Context: PmfReshape blamed 239 mismatches on "stale fixtures"; `git status src/` was clean. The causes were a misplaced `.floor()`, Rust `round()` vs JS `Math.round` (.5 toward +Infinity), and `attr: None` where TS has `attr: {}`.
Decision: The fixtures are current unless `git status src/` shows a change; read the `first difference:` path and compare that field's TS code path. JS rounding is `js_round` (floor(x) + 1 when x - floor(x) >= 0.5), never `f64::round`. TS `attr: {}` is `Some(empty)`, TS `attr: undefined` is `None`.

## ADR-016: Recursion depth is capped; past it, the JS stack-overflow error
Status: accepted (2026-11-17)
Context: The parsers recurse once per nesting level. In TS, nesting 2,000 deep parses and 5,000 deep throws a catchable `RangeError: Maximum call stack size exceeded` (the exact point depends on V8's stack). In Rust the same recursion overflows the thread stack and aborts the process.
Decision: Every input-driven recursion (parser grammar, scaleDice) carries a depth counter. `MAX_DEPTH = 500` (amended twice on 2026-11-17: from 4000, then from 1000 because the worst nesting shape used ~1.6 MB of a 2 MB debug stack on aarch64, too thin for x86; a debug build overflowed a 2 MB stack near 1,400 levels; running on a big-stack thread is ruled out because wasm has no threads (ADR-003) and a thread per call costs the grind). No threads: at or below it, behave as TS; past it, fail as TS does past its stack, with the error `RangeError: Maximum call stack size exceeded` flowing through the same wrapping (e.g. `Cannot parse dice expression [...]: RangeError: Maximum call stack size exceeded`). Depth 500 must not overflow a 2 MB thread stack in a debug build, for every nesting shape (tests in grammar.rs run on a 2 MB thread).
Consequences: Between 500 and V8's real limit (about 2,000-5,000), Rust errors where TS succeeds; no fixture or caller nests past about 10.

## ADR-017: Inputs where TS hangs, overflows or returns garbage may return Err
Status: accepted (2026-11-17)
Context: Ports keep meeting inputs no caller sends where the TS never returns (unbounded loops, `scaleParsedDice` at depth 5,000), aborts (out of memory) or computes nonsense (a non-integer die count indexing arrays). ADR-007 (size guard) and ADR-016 (depth cap) were the first two cases.
Decision: For such inputs the port may return `Err` with a clear message instead of reproducing the failure. Each one is listed in the module's doc comment and covered by a unit test. Anything a recorded or test-suite case reaches must still match the TS exactly.
Consequences: Known so far: `reroll_pool` (die count not an integer in 1..=1e6, NaN budget, infinite rolls), ADR-007 sizes in `common`, ADR-016 depth in the parser.

## ADR-018: Node facade is handle-based; batching and caching live in Rust
Status: accepted (2026-11-17)
Context: dpr's grind makes 600-900 outermost dice calls per nova level term (~15-20M per job; most are tiny: `PMF#mean`, `RollBuilder#plus`, `toPMF`, `PMF#min`), and builds turn specs holding RollBuilder objects. At ~0.3 µs per napi crossing that is ~5 s of a ~260 s job. A descriptive facade (TS records builder chains, Rust replays them on evaluation) would cut crossings but would make every getter on a builder re-run the chain, and doubles the API to keep in sync.
Decision:
- `rust/dice-node` (napi-rs) exposes Rust objects as native handles; the TS facade (`rust/dice-node/ts/`) mirrors the TS module paths and classes 1:1, one crossing per method. Values (`PMF.map`, `singles`, ...) are materialized lazily and cached on the immutable JS object.
- Throughput comes from the Rust side, not from the facade: (1) a Rust PMF cache (convolve/power/parse, keyed like the TS `pmfCache`), because the grind re-derives the same PMFs constantly; (2) a batch entry point `Turn.evaluateMany(turns, acs, readers)` / `evaluateTurns` that evaluates many turn handles in one crossing and, under napi, in parallel (rayon), for callers that score many candidates at once.
- wasm (browser) later reuses the same TS facade over a wasm-bindgen crate with the same method names; no threads there.
Consequences: The facade is mechanical to generate and to test with the TS suite. The batch API is an addition, adopted by dpr where it scores candidate lists.

## ADR-019: Arc-backed builders in the idiom pass
Status: accepted (2026-11-17)
Context: `RollBuilder` stores `configs` and a large `RollKind` inline; every fluent step and every enum that carries a builder (`SidesOrDie`, `SaveOutcome`, `CritEffect`, `RollUnder`) copies it, and clippy flags `large_enum_variant` on four enums.
Decision: For the faithful port, a crate-level `#![allow(clippy::large_enum_variant)]` with this ADR as the reason. The idiom pass makes `RollBuilder`, `AttackBuilder`, `SaveBuilder` and `Pmf` immutable Arc-backed values (cheap clones, structural sharing) and removes the allow.

## ADR-020: Typed errors; JS class travels as a tag
Status: accepted (2026-11-18)
Context: The port returned `Result<_, String>` and the facade rebuilt JS error classes by parsing message text.
Decision: `yipe_dice::DiceError` (thiserror) has one variant per TS error class (Error, RangeError, TypeError, DiceParseError, ParsedCheckError, AmbiguousKeep/CritDoubling, UndoubleableExpression, TurnSpecError, HostThrew). `Display` is the JS `.message`, byte-identical to the TS. The binding throws a JSON-tagged message (`"\u0001dice:" + {class, message, ...fields}`); `ts/native.ts` maps the tag to the registered class.
Consequences: No message sniffing anywhere; new error classes need a variant plus a `registerErrorClass` call.
