#!/usr/bin/env node
'use strict';

// Benchmark fixtures: real-world source maps, from 45 KB (react) to 45 MB
// (vscode). They're too big to commit, so they're downloaded on first use from
// a pinned jridgewell/sourcemaps commit into benchmarks/fixtures/ (gitignored)
// and checked against a sha256.
//
//   node benchmarks/fixtures.js                # download all of them
//   node benchmarks/fixtures.js react.js.map   # download one

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decode } = require('./codec');

const COMMIT = 'b7600158f4de012d246b7834a73c7c2190e75136';
const BASE_URL = `https://raw.githubusercontent.com/jridgewell/sourcemaps/${COMMIT}/packages/trace-mapping/benchmark/`;

// name → sha256
const FIXTURES = {
  'react.js.map':
    '96c59e94a65d64596d0e2b19da22318c3deaa955ddbf47437c5118bee6c6e67e',
  'preact.js.map':
    '9799caf4091eae56de1db1ba28ab8afaf4ca1d42a7d3a94096af8156cb4c2127',
  'amp.js.map':
    '9876a16c5e90e3d684453c738238a2be0be2ec92b3805e6e033d3a1003d62927',
  'issue-41.js.map':
    '8cccce3f5d4a43c29a184e049d2c0408625a7871a46dae05a3f6d49753f36945',
  'babel.min.js.map':
    '63489c676e78c1f461bd3862197bfa1c641473f2905569e87227ae58c711093c',
  'vscode.map':
    '3fdceff393cd10a80a2c2b07cf0b66460a25ce525e338e6ded7f2e91ab144ac9',
};

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Downloads the named fixtures that aren't on disk yet.
async function ensureFixtures(names) {
  for (const name of names) {
    if (!(name in FIXTURES)) {
      throw new Error(
        `Unknown fixture ${name}. Available: ${Object.keys(FIXTURES).join(', ')}`
      );
    }
    const file = path.join(FIXTURES_DIR, name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    process.stderr.write(`Downloading fixture ${name}...\n`);
    const res = await fetch(BASE_URL + name);
    if (!res.ok) {
      throw new Error(`Downloading ${name} failed: HTTP ${res.status}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== FIXTURES[name]) {
      throw new Error(
        `${name}: sha256 mismatch (expected ${FIXTURES[name]}, got ${hash})`
      );
    }
    fs.writeFileSync(file + '.tmp', data);
    fs.renameSync(file + '.tmp', file);
  }
}

// Reads a downloaded fixture. `lines` (the decoded mappings) is computed on
// first access, since only some cases need it.
function loadFixture(name) {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  const map = JSON.parse(text);
  let lines;
  return {
    name,
    text,
    map,
    get lines() {
      if (!lines) lines = decode(map.mappings);
      return lines;
    },
  };
}

exports.FIXTURES = FIXTURES;
exports.ensureFixtures = ensureFixtures;
exports.loadFixture = loadFixture;

if (require.main === module) {
  const names = process.argv.slice(2);
  ensureFixtures(names.length ? names : Object.keys(FIXTURES)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
