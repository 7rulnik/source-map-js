# Benchmarks

Ported from [jridgewell/sourcemaps](https://github.com/jridgewell/sourcemaps)
(`packages/trace-mapping/benchmark` and `packages/gen-mapping/benchmark`).

Two suites:

- `trace.mjs` — parse + `originalPositionFor` + `generatedPositionFor`
- `generate.mjs` — `addMapping` + serialization (`toJSON`)

Each suite runs once per `.map` fixture in `fixtures/` and reports memory
usage, init speed, trace/add speed, and serialize speed via
[`benchmark`](https://www.npmjs.com/package/benchmark).

## Comparisons

Both suites benchmark the **local** `source-map-js` (imported from
`../../source-map.js`) against the same comparison set used upstream:

- [`@jridgewell/trace-mapping`](https://www.npmjs.com/package/@jridgewell/trace-mapping) / [`@jridgewell/gen-mapping`](https://www.npmjs.com/package/@jridgewell/gen-mapping)
- [`source-map@0.6.1`](https://www.npmjs.com/package/source-map/v/0.6.1)
- [`source-map@0.8.0-beta.0`](https://www.npmjs.com/package/source-map/v/0.8.0-beta.0) (wasm)
- Chrome DevTools' `SourceMap` (in `chrome.mjs`, trace suite only)

## Running

```sh
yarn install
yarn bench:jridgewell:trace
yarn bench:jridgewell:generate
```

Both scripts pass `--expose-gc` and `--max-old-space-size=8192` so the memory
deltas are meaningful and `vscode.map` (45MB) can be parsed.

### Filtering to one fixture

```sh
FILE=react.js.map yarn bench:jridgewell:trace
```

### Comparing local vs published source-map-js

`DIFF=1` swaps the third-party comparisons for the published `source-map-js`
(installed as `source-map-js-latest`) so you can A/B local changes against the
last release:

```sh
DIFF=1 yarn bench:jridgewell:trace
DIFF=1 yarn bench:jridgewell:generate
```

## Fixtures

All in `fixtures/`:

| File | Size | Notes |
| --- | --- | --- |
| `amp.js.map` | 392 KB | |
| `babel.min.js.map` | 2.5 MB | |
| `issue-41.js.map` | 1.6 MB | regression fixture for trace-mapping#41 |
| `preact.js.map` | 67 KB | |
| `react.js.map` | 45 KB | smallest — good for smoke-tests |
| `vscode.map` | 45 MB | largest, exercises the slow paths |
