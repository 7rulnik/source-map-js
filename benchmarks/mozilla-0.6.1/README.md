# mozilla/source-map @ 0.6.1 — bench/

Ported from
[mozilla/source-map `bench/` at 0.6.1](https://github.com/mozilla/source-map/tree/0.6.1/bench).

Two benchmarks: parse a source map, and serialize one. Run from the repo root:

```
yarn bench:mozilla-0.6.1
```

(`bench-shell-bindings.js` runs under Node — `load()` is shimmed via `vm`, and
the library is `require`d from `../../source-map.js` so library changes are
picked up without a rebuild.)

Upstream's `bench.html` and `bench-dom-bindings.js` (browser entry) are not
ported.
