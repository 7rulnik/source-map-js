# mozilla/source-map @ master — bench/

Ported from
[mozilla/source-map `bench/` at master](https://github.com/mozilla/source-map/tree/master/bench).
`bench.js`, `stats.js`, and the fixture maps come from upstream with adaptations
for the synchronous source-map-js API (no WASM, no `await new SourceMapConsumer`,
no `destroy()`).

`bench-cli.js` is the Node driver — it evaluates `bench.js`, `stats.js`, and the
chosen fixture inside a `vm` context so `bench.js` itself stays 1:1 with
upstream.

```
$ yarn bench:mozilla-master --help
$ yarn bench:mozilla-master --list
$ yarn bench:mozilla-master --map SELF_SOURCE_MAP --warmup 5 --iters 100
$ yarn bench:mozilla-master --bench iterate.already.parsed --csv
```

The `*.r` scripts are upstream R helpers for analyzing CSV output (`--csv`).
