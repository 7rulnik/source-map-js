#!/usr/bin/env node
/* eslint-env node */
//
// bench-delta.js — diff two jridgewell-bench outputs for the
// `source-map-js current` rows only.
//
// Usage: node scripts/bench-delta.js <candidate.log> <baseline.log>
//
// Parses the bench logs (from `yarn bench:jridgewell:trace` and / or
// `yarn bench:jridgewell:generate`), extracts ops/sec for every line whose
// label starts with "source-map-js current", grouped by fixture and suite,
// then prints a candidate-vs-baseline delta table.

'use strict';

const fs = require('fs');

const SUITE_HEADERS = new Set([
  'Init speed',
  'Trace speed (random)',
  'Trace speed (ascending)',
  'Generated Positions init',
  'Generated Positions speed',
  'Adding speed',
  'Generate speed',
]);

function parse(text) {
  const out = new Map(); // key: `${fixture}|${suite}|${op}` → hz
  let fixture = null;
  let suite = null;

  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    // Fixture header: e.g. "preact.js.map - 1992 segments"
    let m = /^([\w.-]+\.(?:map|js\.map))\s*-\s*\d+\s*segments\b/.exec(line);
    if (m) { fixture = m[1]; suite = null; continue; }

    // generate.mjs prints just the fixture name (no "- N segments")
    if (/^[\w.-]+\.(?:map|js\.map)\s*$/.test(line.trim())) {
      fixture = line.trim();
      suite = null;
      continue;
    }

    // Suite header: e.g. "Init speed:"
    m = /^([A-Z][\w()\s]+):\s*$/.exec(line);
    if (m && SUITE_HEADERS.has(m[1])) { suite = m[1]; continue; }

    // Result line: "source-map-js current[:] <op> x 3,398 ops/sec ..."
    m = /^source-map-js current:?\s*(.+?)\s*x\s*([\d,.]+)\s*ops\/sec\b/.exec(line);
    if (m) {
      if (!fixture || !suite) continue;
      const op = m[1].trim();
      const hz = Number(m[2].replace(/,/g, ''));
      if (!Number.isFinite(hz)) continue;
      out.set(`${fixture}|${suite}|${op}`, hz);
    }
  }
  return out;
}

function fmtHz(hz) {
  if (hz >= 1e6) return (hz / 1e6).toFixed(2) + 'M';
  if (hz >= 1e3) return (hz / 1e3).toFixed(1) + 'k';
  return hz.toFixed(0);
}

function fmtDelta(deltaPct) {
  const sign = deltaPct >= 0 ? '+' : '';
  const s = sign + deltaPct.toFixed(1) + '%';
  return s.padStart(8);
}

function main() {
  const [, , candPath, basePath] = process.argv;
  if (!candPath || !basePath) {
    console.error('Usage: bench-delta.js <candidate.log> <baseline.log>');
    process.exit(1);
  }
  const cand = parse(fs.readFileSync(candPath, 'utf8'));
  const base = parse(fs.readFileSync(basePath, 'utf8'));

  if (cand.size === 0 || base.size === 0) {
    console.error('No "source-map-js current" lines parsed.');
    console.error(`  candidate rows: ${cand.size}`);
    console.error(`  baseline rows:  ${base.size}`);
    process.exit(2);
  }

  // Group by fixture, then suite
  const byFixture = new Map();
  const allKeys = new Set([...cand.keys(), ...base.keys()]);
  for (const key of allKeys) {
    const [fixture, suite, op] = key.split('|');
    if (!byFixture.has(fixture)) byFixture.set(fixture, new Map());
    const suites = byFixture.get(fixture);
    if (!suites.has(suite)) suites.set(suite, []);
    suites.get(suite).push({ op, key });
  }

  let summed = 0;
  let n = 0;
  let worstName = null;
  let worstPct = 0;
  let bestName = null;
  let bestPct = 0;

  for (const [fixture, suites] of byFixture) {
    console.log('');
    console.log(fixture);
    for (const [suite, rows] of suites) {
      console.log(`  ${suite}`);
      for (const { op, key } of rows) {
        const c = cand.get(key);
        const b = base.get(key);
        if (c == null || b == null) {
          console.log(`    ${op.padEnd(40)} ${c == null ? '(missing in candidate)' : '(missing in baseline)'}`);
          continue;
        }
        const deltaPct = ((c - b) / b) * 100;
        summed += deltaPct;
        n++;
        if (deltaPct > bestPct) { bestPct = deltaPct; bestName = `${fixture} / ${suite} / ${op}`; }
        if (deltaPct < worstPct) { worstPct = deltaPct; worstName = `${fixture} / ${suite} / ${op}`; }
        const cStr = fmtHz(c).padStart(8);
        const bStr = fmtHz(b).padStart(8);
        console.log(`    ${op.padEnd(40)} cand ${cStr}  base ${bStr}  Δ ${fmtDelta(deltaPct)}`);
      }
    }
  }

  console.log('');
  console.log('=================================================================');
  console.log('  Summary');
  console.log('=================================================================');
  if (n > 0) {
    const avg = summed / n;
    console.log(`  rows compared : ${n}`);
    console.log(`  mean delta    : ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    if (bestName)  console.log(`  best          : ${bestPct >= 0 ? '+' : ''}${bestPct.toFixed(1)}%  (${bestName})`);
    if (worstName) console.log(`  worst         : ${worstPct >= 0 ? '+' : ''}${worstPct.toFixed(1)}%  (${worstName})`);
  }
}

main();
