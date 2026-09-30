#!/usr/bin/env node
/* eslint-env node */
//
// bench-fromsourcemap.js — focused microbench for
// BasicSourceMapConsumer.fromSourceMap.
//
// The jridgewell trace/generate fixtures don't exercise the
// `SourceMapConsumer.fromSourceMap(generator)` path — the one used by
// roundtrip / applySourceMap workflows. This script primes a
// SourceMapGenerator from each fixture via SourceMapGenerator.fromSourceMap,
// then times SourceMapConsumer.fromSourceMap on that generator.
//
// Usage:
//   node scripts/bench-fromsourcemap.js              # all fixtures
//   node scripts/bench-fromsourcemap.js babel.min    # one fixture (prefix match)

'use strict';

const fs = require('fs');
const path = require('path');
const Benchmark = require('benchmark');
const { SourceMapConsumer, SourceMapGenerator } = require('../source-map.js');

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
  let map;
  try { map = JSON.parse(raw); } catch (e) { continue; }
  if (map.sections) continue;
  if (!map.mappings) continue;

  // Build the generator once outside the timed loop — fromSourceMap is what
  // we're measuring, not parse/generate.
  const consumer = new SourceMapConsumer(map);
  const generator = SourceMapGenerator.fromSourceMap(consumer);

  const segments = (map.mappings.match(/[,;]/g) || []).length + 1;
  console.log('');
  console.log(file + ' - ' + segments + ' segments');
  console.log('SourceMapConsumer.fromSourceMap speed:');

  const suite = new Benchmark.Suite()
    .add('source-map-js current: fromSourceMap', () => {
      SourceMapConsumer.fromSourceMap(generator);
    })
    .on('cycle', (ev) => { console.log('  ' + String(ev.target)); })
    .on('complete', function () {
      console.log('  Fastest is ' + this.filter('fastest').map('name'));
    });

  suite.run({ async: false });
}
