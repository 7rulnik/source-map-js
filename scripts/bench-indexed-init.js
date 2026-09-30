#!/usr/bin/env node
/* eslint-env node */
//
// bench-indexed-init.js — focused microbench for IndexedSourceMapConsumer init.
//
// The jridgewell trace fixtures are all basic (no `sections`), so the standard
// bench rig doesn't exercise IndexedSourceMapConsumer._parseMappings. This
// script wraps each fixture into a synthetic sections map and times
// `new SourceMapConsumer(...)` (which runs the indexed parse + the final
// __originalMappings sort that this PR changes).
//
// Usage:
//   node scripts/bench-indexed-init.js              # all fixtures
//   node scripts/bench-indexed-init.js babel.min    # one fixture (prefix match)

'use strict';

const fs = require('fs');
const path = require('path');
const Benchmark = require('benchmark');
const { SourceMapConsumer } = require('../source-map.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'benchmarks', 'jridgewell', 'fixtures');
const ONLY = process.argv[2];

const fixtures = fs.readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.map') || f.endsWith('.js.map'))
  .filter((f) => !ONLY || f.startsWith(ONLY));

if (fixtures.length === 0) {
  console.error('No fixtures matched.');
  process.exit(1);
}

for (const file of fixtures) {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
  let basic;
  try { basic = JSON.parse(raw); } catch (e) { continue; }
  if (basic.sections) continue;
  if (!basic.mappings) continue;

  // Wrap into a single-section indexed map so IndexedSourceMapConsumer
  // handles it. One section is enough to drive the bucketing / final sort.
  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: basic }
    ]
  };

  const segments = (basic.mappings.match(/[,;]/g) || []).length + 1;
  console.log('');
  console.log(file + ' (indexed wrap) - ' + segments + ' segments');
  console.log('IndexedSourceMapConsumer init:');

  const suite = new Benchmark.Suite()
    .add('source-map-js current: encoded indexed init', () => {
      new SourceMapConsumer(indexed);
    })
    .on('cycle', (ev) => { console.log('  ' + String(ev.target)); })
    .on('complete', function () {
      console.log('  Fastest is ' + this.filter('fastest').map('name'));
    });

  suite.run({ async: false });
}
