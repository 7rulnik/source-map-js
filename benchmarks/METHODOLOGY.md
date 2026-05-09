# Benchmark methodology

Three suites live here. They have different strengths; pick the right one for what you're doing.

## Pick by task

| Task | Suite | Why |
| --- | --- | --- |
| Compare an optimization A/B | `jridgewell` with `DIFF=1` | benchmark.js gives statistical ops/sec with ±error%, side-by-side comparison, splits init from steady-state |
| Quick iteration during development | `FILE=react.js.map DIFF=1 yarn bench:jridgewell:trace` | ~30s; skips vscode.map's multi-minute cost |
| Independent sanity check (different methodology) | `mozilla-master` | No benchmark.js — single-iteration `console.time` per sample, separate code path |
| Historical parity vs mozilla 0.6.1 | `mozilla-0.6.1` | Only useful for parity claims — single fixture, parse + serialize only, no lookups |

## When to re-run

Usually *not* needed — benchmark.js already quantifies within-run noise via the ±% column. Re-run only for:

- **vscode.map results** — few samples fit in benchmark.js's cycle budget, so ±5–10% is normal there.
- **Sub-5% wins** where you want to rule out a transient hiccup.

What re-running does *not* fix:

- **Order-dependent JIT bias.** V8's optimizer state depends on which code ran first; same order in both runs reproduces the same bias. Mitigation: randomize fixture order, or split heavy fixtures into separate processes.
- **Thermal throttling on long suites.** Late fixtures may run hotter than early ones. Mitigation: run heavy fixtures in isolated processes (`FILE=vscode.map ...`) so each starts cold.

## DIFF mode caveat

`DIFF=1` swaps the third-party comparisons (trace-mapping, source-map-0.6.1/0.8.0, Chrome) for `source-map-js@latest` (the *published* version on npm). It does **not** compare local HEAD against the previous commit on this branch.

For unreleased-vs-prev-commit comparison, you have two options:

1. Run the bench on each side: `git stash && yarn bench:... > before.txt; git stash pop && yarn bench:... > after.txt`, then diff.
2. Extend `trace.mjs` / `generate.mjs` to import a second local copy under a different path. Worth the time only if you'll iterate a lot.

## Measurement gotchas (project-specific)

### 1. Memory column for lazy-init libraries

`source-map-0.8.0` (WASM) and trace-mapping with decoded-Object input both **defer parse until the first query**. The bench's memory tracker calls `originalPositionFor` and `generatedPositionFor` once before snapshotting, but that doesn't fully build the per-source reverse index — only the bucket for the queried source.

Concrete consequence: source-map-0.8.0 reports 37 KB for issue-41 (313k segments). That number is real but not comparable to source-map-js's eager 49 MB — it reflects what's been allocated *so far*, not the full cost.

To make the memory comparison apples-to-apples, you would need to force exhaustive lookups across all sources. Currently not done, by design — the bench is consistent with how upstream measures.

### 2. Random vs ascending trace gap measures cache, not raw speed

trace-mapping's per-line memoized search cache turns ascending walks into amortized O(1). The "ascending" workload exposes this; "random" doesn't. If your optimization touches the consumer's query state, look at *both* — a memoization win shows up only on ascending.

### 3. `_findSourceIndex` cost on `generatedPositionFor`

`generatedPositionFor` resolves the source URL to an index on every call. For random-source workloads the resolution is amortized; for hot single-source loops the lookup itself is part of the steady-state ops/sec. Don't attribute its cost to the binary search.

### 4. WASM module is loaded once per process

source-map-0.8.0's first measurement in any process pays the WASM module load (~10 MB of linear memory). Subsequent fixtures don't. This means **construction-cost numbers for 0.8.0 are biased low for every fixture except the first one** in a single bench process. Reading order matters when interpreting init-speed columns.

## Reading the output

Each bench file in `bench-results/` starts with the producing command. The body is benchmark.js cycle output:

```
source-map-js current: encoded originalPositionFor x 78,145 ops/sec ±1.89% (91 runs sampled)
```

A "win" smaller than the larger of the two ±% values is noise. If a measurement has fewer than ~15 samples, treat it as a rough estimate.

## Suite-specific notes

- **`jridgewell/`**: ported from `@jridgewell/sourcemaps`. Six fixtures from 45 KB (react) to 45 MB (vscode). Two scripts: `trace.mjs` (parse + lookup) and `generate.mjs` (addMapping + serialize). Run via `yarn bench:jridgewell:trace` / `yarn bench:jridgewell:generate`. `FILE=name.map` filters; `DIFF=1` swaps the comparison set.

- **`mozilla-master/`**: ported from `mozilla/source-map@master`. Three fixtures: scalajs, angular-min, self. Seven named benchmarks covering cold/warm parse and lookup. Use `--list` to see them; `--bench NAME` to run one. `--csv` emits per-sample data for the included R scripts (`size.r`, `plot.r`).

- **`mozilla-0.6.1/`**: ported from `mozilla/source-map@0.6.1`. Single fixture (scalajs), parses + serializes once, prints wall-clock time. No statistical sampling, no lookup operations. Keep for parity claims; do not use for optimization work.
