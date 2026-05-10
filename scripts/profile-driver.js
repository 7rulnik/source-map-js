/* eslint-env node */
//
// profile-driver.js — runs ONE scenario against ONE fixture, sized so a
// single node invocation under --cpu-prof / --heap-prof / --prof produces a
// useful profile. Pair with scripts/profile.sh, which wraps node with the
// right flags.
//
// Env vars:
//   SCENARIO   init | opf | gpf | eachmap-gen | eachmap-orig   (default: opf)
//   FIXTURE    path under benchmarks/jridgewell/fixtures       (default: babel.min.js.map)
//   ITERS      override per-scenario iteration count           (optional)
//   WARMUP     warmup iters before the measured loop           (default: scenario-specific)
//
// The driver intentionally does *only* the scenario inside the measured loop.
// Fixture read + JSON.parse happen up front so disk/JSON cost doesn't pollute
// the profile. The Consumer is also re-used across iterations for opf / gpf /
// eachmap scenarios so we measure the steady-state hot path, not init.

'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const { SourceMapConsumer } = require('../source-map.js');

const SCENARIO = process.env.SCENARIO || 'opf';
const FIXTURE_NAME = process.env.FIXTURE || 'babel.min.js.map';
const FIXTURE_PATH = path.isAbsolute(FIXTURE_NAME)
  ? FIXTURE_NAME
  : path.join(__dirname, '..', 'benchmarks', 'jridgewell', 'fixtures', FIXTURE_NAME);

const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
const json = JSON.parse(raw);

// Build a deterministic set of (line, column) probes drawn from the decoded
// mapping table itself. Random probes that miss every mapping line would skew
// the profile toward "binary-search-the-empty-line" code paths.
function buildOpfProbes(consumer, count) {
  const probes = [];
  consumer.eachMapping((m) => {
    probes.push({ line: m.generatedLine, column: m.generatedColumn });
  });
  if (probes.length === 0) return probes;
  const stride = Math.max(1, Math.floor(probes.length / count));
  const out = [];
  for (let i = 0; i < probes.length && out.length < count; i += stride) {
    out.push(probes[i]);
  }
  return out;
}

function buildGpfProbes(consumer, count) {
  const probes = [];
  consumer.eachMapping((m) => {
    if (m.source) {
      probes.push({ source: m.source, line: m.originalLine, column: m.originalColumn });
    }
  });
  if (probes.length === 0) return probes;
  const stride = Math.max(1, Math.floor(probes.length / count));
  const out = [];
  for (let i = 0; i < probes.length && out.length < count; i += stride) {
    out.push(probes[i]);
  }
  return out;
}

const scenarios = {
  init({ iters }) {
    iters = iters || 30;
    // No warmup: every iteration is a fresh init, that's the whole point.
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      const c = new SourceMapConsumer(json);
      // Touch one position so the lazy parts that the constructor schedules
      // actually run (e.g. the originalPositionFor warmup that triggers
      // _buildOriginalMappings on first call is excluded — see gpf scenario).
      const r = c.originalPositionFor({ line: 1, column: 0 });
      sink += r.line || 0;
    }
    return { iters, ms: performance.now() - t0, sink };
  },

  opf({ iters, warmup }) {
    iters = iters || 5_000_000;
    warmup = warmup == null ? 5000 : warmup;
    const c = new SourceMapConsumer(json);
    const probes = buildOpfProbes(c, 5000);
    if (probes.length === 0) throw new Error('no probes built');
    // Warmup: triggers JIT tier-up so the profile reflects optimized code.
    for (let i = 0; i < warmup; i++) {
      const p = probes[i % probes.length];
      c.originalPositionFor(p);
    }
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      const p = probes[i % probes.length];
      const r = c.originalPositionFor(p);
      sink += r.line || 0;
    }
    return { iters, ms: performance.now() - t0, sink };
  },

  gpf({ iters, warmup }) {
    iters = iters || 3_000_000;
    warmup = warmup == null ? 5000 : warmup;
    const c = new SourceMapConsumer(json);
    const probes = buildGpfProbes(c, 5000);
    if (probes.length === 0) throw new Error('no probes built');
    for (let i = 0; i < warmup; i++) {
      const p = probes[i % probes.length];
      c.generatedPositionFor(p);
    }
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      const p = probes[i % probes.length];
      const r = c.generatedPositionFor(p);
      sink += r.line || 0;
    }
    return { iters, ms: performance.now() - t0, sink };
  },

  'eachmap-gen': function ({ iters, warmup }) {
    iters = iters || 300;
    warmup = warmup == null ? 3 : warmup;
    const c = new SourceMapConsumer(json);
    let sink = 0;
    for (let i = 0; i < warmup; i++) c.eachMapping(() => {});
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      c.eachMapping((m) => {
        sink += m.generatedLine | 0;
      });
    }
    return { iters, ms: performance.now() - t0, sink };
  },

  'eachmap-orig': function ({ iters, warmup }) {
    iters = iters || 300;
    warmup = warmup == null ? 3 : warmup;
    const c = new SourceMapConsumer(json);
    const ORIG = SourceMapConsumer.ORIGINAL_ORDER;
    let sink = 0;
    for (let i = 0; i < warmup; i++) c.eachMapping(() => {}, null, ORIG);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      c.eachMapping((m) => {
        sink += m.generatedLine | 0;
      }, null, ORIG);
    }
    return { iters, ms: performance.now() - t0, sink };
  },
};

if (!scenarios[SCENARIO]) {
  console.error(`unknown SCENARIO=${SCENARIO}; expected one of: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

const iters = process.env.ITERS ? Number(process.env.ITERS) : undefined;
const warmup = process.env.WARMUP != null ? Number(process.env.WARMUP) : undefined;

console.log(`scenario=${SCENARIO}  fixture=${path.basename(FIXTURE_PATH)}  node=${process.version}`);
const result = scenarios[SCENARIO]({ iters, warmup });
console.log(
  `  iters=${result.iters}  total=${result.ms.toFixed(1)}ms  per-iter=${(result.ms / result.iters).toFixed(4)}ms  sink=${result.sink}`,
);
