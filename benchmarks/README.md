# Benchmarks

Two suites, for two questions:

- [Before/after](#beforeafter) (`pnpm bench`): is a change to source-map-js
  faster or slower than the code it replaces?
- [Comparison](#comparison) (`pnpm bench:compare`): how does source-map-js do
  against other source map libraries? The latest results are in
  [RESULTS.md](RESULTS.md).

The benchmarks need Node 18 or newer. The library supports Node 6, but the
benchmarks don't.

## Before/after

`pnpm bench` answers one question: is a change faster or slower than the code
it replaces?

```sh
pnpm bench                                     # working tree vs origin/main
pnpm bench --base v1.2.2 --head HEAD           # any two commits
pnpm bench --cases opf-random,opf-ascending    # only some cases
pnpm bench --fixtures all                      # all six fixtures (slow)
pnpm bench --list                              # fixtures and cases
pnpm bench --help
```

It prints one row per case × fixture:

```
amp.js.map            base       head   change             95% CI
  opf-random       6.53 ms    7.55 ms   -13.5%   [-14.6%, -12.7%]   slower
  gpf-random       5.35 ms    5.32 ms    +1.0%     [-1.4%, +3.4%]
```

`base` and `head` are the median time of one run of the case. `change` is
head's speed relative to base, so `+` means head is faster. A row is marked
`faster` or `slower` only when the 95% confidence interval excludes 0 and the
change is at least 1%. `(!)` means base and head returned different results,
or that results varied between runs. Either way, the change isn't just a
performance change.

### How it measures

- **Every measurement is its own process** (`worker.js`). Most of the variation
  is between processes (JIT decisions, heap layout, which core the OS picks),
  so a single process can't say how noisy a number is. A fresh process per
  measurement also keeps cases from affecting each other through JIT state.
- **Base and head run in pairs, back to back**, alternating which goes first.
  Each round covers every case × fixture before the next round starts, so slow
  drift (heat, background load) affects both sides equally.
- **The result is the median of the per-pair ratios**, with a 95% confidence
  interval that makes no assumption about the noise distribution
  (`stats.js`). One outlier process can't move it.
- **The inputs are identical on both sides.** Queries come from a seeded PRNG,
  and `addMapping()` arguments come from a standalone decoder (`codec.js`),
  not from the library under test.
- **Both sides load the library from a temp copy**: `git archive` for a
  commit, a copy for the working tree. Editing files during a run doesn't
  affect it.

### Noise and run time

To see the noise floor on your machine, compare a clean tree with itself:
`pnpm bench --base HEAD`. On an Apple M4 Max, the default 10 pairs give
confidence intervals of about ±1–2%. To resolve smaller changes, raise
`--runs`.

A process takes about 0.8 s on the small fixtures and up to 2.5 s on
`vscode.map`. The default run (2 fixtures × 10 cases × 10 pairs, so 400
processes) takes about 5 minutes. Use `--cases` and `--fixtures` to cover only
what the change touches.

For stable numbers, plug the laptop in, and don't run anything else heavy at
the same time, including another benchmark.

## Comparison

`pnpm bench:compare` runs the same work on several source map libraries and
reports each one's time and memory next to source-map-js's.

The other libraries are pinned in `benchmarks/package.json`, apart from the
library's own dependencies, so install them once first:

```sh
pnpm --dir benchmarks install
pnpm bench:compare                                     # everything (~16 minutes)
pnpm bench:compare --fixtures react.js.map,amp.js.map  # only some fixtures
pnpm bench:compare --libs smjs,trace-mapping           # only some libraries
pnpm bench:compare --markdown benchmarks/RESULTS.md    # regenerate RESULTS.md
pnpm bench:compare --list                              # libraries, fixtures and cases
```

| Id              | Library                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `smjs`          | source-map-js, from the working tree                                              |
| `sm-0.6`        | source-map 0.6.1, which source-map-js forked from                                 |
| `sm-0.8`        | source-map 0.8.0, the latest: Rust compiled to WebAssembly, with an async setup   |
| `jr-source-map` | `@jridgewell/source-map`: trace-mapping and gen-mapping behind the source-map API |
| `trace-mapping` | `@jridgewell/trace-mapping` and `@jridgewell/gen-mapping`, used directly          |

To compare source-map-js with one of its own releases, use the before/after
suite instead (`pnpm bench --base v1.2.4`): it's built to resolve small
differences, and this suite isn't.

### How it keeps the comparison fair

- **The same input and the same work.** Every library parses the same JSON
  string and gets the same queries. Each adapter in `libs.js` makes one call
  into the library per operation and passes the library's own objects
  through.
- **Deferred work counts.** Several libraries decode the mappings, or build
  the index `generatedPositionFor()` needs, only on the first query. `parse`
  includes the first `originalPositionFor()` and `parse-both` the first
  `generatedPositionFor()` too, so that work is timed. For source-map 0.8,
  creating the consumer (async) and destroying it are timed as well.
- **Answers are checked.** Each process also records its answers, and the
  report lists every case where a library's answers differ from
  source-map-js's. Some differences are answers that are also right: when
  several generated positions map to the queried original position,
  `generatedPositionFor()` may return any of them, and
  `allGeneratedPositionsFor()` may return them in any order. Those are marked
  `*`, other differences `!`.
- **One process per measurement, in random order.** Each round runs every
  library × case × fixture once, shuffled, so no library always follows the
  same other one. A cell is the median of `--runs` processes (default 5).
- **Memory is measured in a fresh process** with one consumer that has
  answered a query in each direction, so its lazy indexes exist. It counts the
  JS heap, memory V8 tracks outside it (ArrayBuffers), and WebAssembly memory,
  which `process.memoryUsage()` leaves out. WebAssembly memory never shrinks,
  so for source-map 0.8 the number is the most it used at once, temporary
  buffers included.

The libraries differ by much more than the noise, so 5 runs are enough. In a
full run on an Apple M4 Max, a cell's 5 processes typically spanned 3.5% of
its median: 10% at the 90th percentile, and at worst 36%, on 1.5 ms parses.
Read ratios between about 0.9× and 1.1× as "the same". The full run (1,440
processes) took 16 minutes.

## Fixtures

Six real-world source maps, from 45 KB (`react.js.map`) to 45 MB
(`vscode.map`). They're downloaded on first use from a pinned
[jridgewell/sourcemaps](https://github.com/jridgewell/sourcemaps) commit into
`benchmarks/fixtures/` (gitignored), and checked against a sha256.
`pnpm bench:fixtures` downloads all of them up front.

## Adding a case

Before/after cases live in `cases.js`, comparison cases in `compare-cases.js`.
Each one has a `setup(lib, fixture)` that returns `{ run, checksum }`:

- `setup` does everything that shouldn't be timed.
- `run()` is one timed unit of work. It returns a number derived from the
  results, so V8 can't skip the work.
- `checksum()` (optional, defaults to `run`) is a stronger hash of the results,
  computed once per process. Before/after compares it between base and head.
  The comparison compares it between libraries, so there it must not depend on
  how a library represents its answers: one hash per query, built from the
  answer's values.

In `cases.js`, `lib` is source-map-js itself. In `compare-cases.js` it's an
adapter from `libs.js`, so a case can only use operations every adapter has.
To add a library, pin it in `package.json` here and add an adapter.
