/* eslint-env node */
//
// analyze-cpuprofile.js — print top frames by self-time from a .cpuprofile.
//
// Usage: node scripts/analyze-cpuprofile.js path/to/file.cpuprofile [topN]
//
// .cpuprofile format (Chrome DevTools):
//   { nodes: [{id, callFrame:{functionName,url,lineNumber}, hitCount?, children?}],
//     samples: [nodeId,...], timeDeltas: [µs,...] }
// Self-time per node = sum of timeDeltas for samples whose node === id.
// We bucket by (functionName, url) so anonymous closures inside the same file
// merge sensibly.

'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const topN = Number(process.argv[3] || 20);
if (!file) {
  console.error('usage: analyze-cpuprofile.js <file.cpuprofile> [topN]');
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const { nodes, samples, timeDeltas } = profile;

const nodeById = new Map();
for (const n of nodes) nodeById.set(n.id, n);

const selfByNode = new Map();
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  const dt = timeDeltas[i] || 0;
  selfByNode.set(id, (selfByNode.get(id) || 0) + dt);
}

const totalUs = timeDeltas.reduce((a, b) => a + b, 0);

const buckets = new Map();
for (const [id, us] of selfByNode) {
  const node = nodeById.get(id);
  const cf = node.callFrame || {};
  const fn = cf.functionName || '(anonymous)';
  const url = cf.url || '';
  const key = `${fn}\t${url}`;
  buckets.set(key, (buckets.get(key) || 0) + us);
}

const ranked = [...buckets.entries()]
  .map(([k, us]) => {
    const [fn, url] = k.split('\t');
    return { fn, url, us };
  })
  .sort((a, b) => b.us - a.us);

console.log(`# ${path.basename(file)}`);
console.log(`# total profile time: ${(totalUs / 1000).toFixed(1)} ms across ${samples.length} samples`);
console.log('');
console.log('  self%   self_ms  function (file)');
console.log('  ------  -------  -----------------------------------------------------');
for (const row of ranked.slice(0, topN)) {
  const pct = (row.us / totalUs) * 100;
  const ms = row.us / 1000;
  const tag = row.url
    ? path.basename(row.url.replace(/^file:\/\//, ''))
    : '(no-file)';
  const fn = row.fn || '(anonymous)';
  console.log(`  ${pct.toFixed(1).padStart(5)}%  ${ms.toFixed(1).padStart(6)}  ${fn}  (${tag})`);
}
