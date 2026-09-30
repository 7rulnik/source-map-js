#!/usr/bin/env node
// CLI driver for bench-web's bench.js. Runs the same benchmarks as
// bench-dom-bindings.js, in Node, by evaluating bench.js / stats.js / fixtures
// inside a vm context. bench.js itself is left unmodified to stay 1:1 with
// upstream mozilla/source-map master.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parseArgs } = require("node:util");
const { performance } = require("node:perf_hooks");

const HERE = __dirname;

const FIXTURES = {
  SCALA_JS_RUNTIME_SOURCE_MAP: "scalajs-runtime-sourcemap.js",
  ANGULAR_MIN_SOURCE_MAP: "angular-min-source-map.js",
  SELF_SOURCE_MAP: "self-source-map.js",
};

function help() {
  console.log(`Usage: node bench-web/bench-cli.js [options]

Drives bench-web/bench.js (the master mozilla/source-map benchmarks) from CLI.

Options:
  -b, --bench <name>     Run a single benchmark by name (repeatable). Default: all.
      --list             List available benchmarks and exit.
  -m, --map <name>       Input source map (default: SCALA_JS_RUNTIME_SOURCE_MAP).
                         One of: ${Object.keys(FIXTURES).join(", ")}
  -w, --warmup <N>       Warm-up iterations (default: 5).
  -i, --iters <N>        Benchmark iterations (default: 100).
  -x, --multiply <N>     Duplicate map mappings/sources/names N times (default: 1).
  -l, --label <text>     Implementation label for CSV (default: node-<version>).
      --csv              Emit per-sample CSV after each benchmark.
  -h, --help             Show this help.
`);
}

const { values: opts } = parseArgs({
  options: {
    bench: { type: "string", multiple: true, short: "b" },
    list: { type: "boolean", default: false },
    map: { type: "string", short: "m", default: "SCALA_JS_RUNTIME_SOURCE_MAP" },
    warmup: { type: "string", short: "w", default: "5" },
    iters: { type: "string", short: "i", default: "100" },
    multiply: { type: "string", short: "x", default: "1" },
    label: { type: "string", short: "l", default: `node-${process.versions.node}` },
    csv: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (opts.help) {
  help();
  process.exit(0);
}

if (!(opts.map in FIXTURES)) {
  console.error(`Unknown --map ${opts.map}. Choose from: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(1);
}

// Quiet console for inside the vm: bench.js calls console.time/timeEnd around
// every iteration, which Node prints to stderr. Browser dev-tools handles this
// silently unless profiling, so we silence it here too.
const quietConsole = Object.create(console);
quietConsole.time = () => {};
quietConsole.timeEnd = () => {};
quietConsole.profile = () => {};
quietConsole.profileEnd = () => {};

const sandbox = {
  console: quietConsole,
  Promise,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  setInterval,
  clearInterval,
  Math,
  JSON,
  Array,
  Object,
  Error,
  TypeError,
  RangeError,
  Number,
  String,
  Boolean,
  Date,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Proxy,
  Reflect,
  // bench.js picks the `window.performance.now` branch when window is an
  // object — without it, the fallback `() => now()` infinitely recurses
  // (latent upstream bug).
  window: { performance: { now: () => performance.now() } },
  // Iteration counts that bench.js reads as globals (browser sets them via
  // bench-dom-bindings.js + range inputs).
  WARM_UP_ITERATIONS: parseInt(opts.warmup, 10),
  BENCH_ITERATIONS: parseInt(opts.iters, 10),
  // Library under test, exposed as the global bench.js expects.
  sourceMap: require(path.join(HERE, "..", "..", "source-map.js")),
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function runScript(file) {
  vm.runInContext(fs.readFileSync(path.join(HERE, file), "utf8"), sandbox, { filename: file });
}

runScript("stats.js");
runScript(FIXTURES[opts.map]);

// Reproduce updateTestSourceMap() from bench-dom-bindings.js.
const origMap = sandbox[opts.map];
const testSourceMap = JSON.parse(JSON.stringify(origMap));
const factor = parseInt(opts.multiply, 10);
if (factor > 1) {
  testSourceMap.mappings = new Array(factor).fill(origMap.mappings).join(";");
  for (let i = 0; i < factor; i++) {
    testSourceMap.sources.splice(testSourceMap.sources.length, 0, ...origMap.sources);
    testSourceMap.names.splice(testSourceMap.names.length, 0, ...origMap.names);
  }
}
sandbox.testSourceMap = testSourceMap;

runScript("bench.js");

const benchmarks = sandbox.benchmarks;
const allNames = Object.keys(benchmarks);

if (opts.list) {
  for (const name of allNames) {
    console.log(name);
    console.log(`  ${benchmarks[name].description}`);
  }
  process.exit(0);
}

const requested = opts.bench && opts.bench.length ? opts.bench : allNames;
const unknown = requested.filter((n) => !allNames.includes(n));
if (unknown.length) {
  console.error(`Unknown benchmark(s): ${unknown.join(", ")}`);
  console.error(`Available: ${allNames.join(", ")}`);
  process.exit(1);
}

(async () => {
  for (const name of requested) {
    const b = benchmarks[name];
    console.log(`\n=== ${name} ===`);
    console.log(b.description);
    const stats = await b.run();
    console.log(`samples: ${stats.samples()}`);
    console.log(`total:   ${stats.total().toFixed(2)} ${stats.unit}`);
    console.log(`mean:    ${stats.mean().toFixed(2)} ${stats.unit}`);
    console.log(`stddev:  ${stats.stddev().toFixed(2)} ${stats.unit}`);

    if (opts.csv) {
      const mLen = sandbox.testSourceMap.mappings.length;
      console.log("--- csv ---");
      for (const x of stats.xs) {
        console.log(`"${opts.label}",${mLen},"${name}",${x}`);
      }
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
