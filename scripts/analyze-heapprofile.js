/* eslint-env node */
//
// analyze-heapprofile.js — top frames by self-allocation bytes from
// node --heap-prof output. Format: { head: { id, callFrame, selfSize,
// children: [...] } }, recursive. selfSize is sampled bytes attributed to
// allocations done directly in that frame.
//
// Usage: node scripts/analyze-heapprofile.js path/to/file.heapprofile [topN]

'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const topN = Number(process.argv[3] || 20);
if (!file) {
  console.error('usage: analyze-heapprofile.js <file.heapprofile> [topN]');
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));

const buckets = new Map();
let total = 0;

(function walk(node) {
  if (node.selfSize > 0) {
    const cf = node.callFrame || {};
    const fn = cf.functionName || '(anonymous)';
    const url = cf.url || '';
    const key = `${fn}\t${url}`;
    buckets.set(key, (buckets.get(key) || 0) + node.selfSize);
    total += node.selfSize;
  }
  if (node.children) for (const c of node.children) walk(c);
})(profile.head);

const ranked = [...buckets.entries()]
  .map(([k, b]) => {
    const [fn, url] = k.split('\t');
    return { fn, url, bytes: b };
  })
  .sort((a, b) => b.bytes - a.bytes);

console.log(`# ${path.basename(file)}`);
console.log(`# total sampled allocations: ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('');
console.log('  alloc%  bytes(KB)  function (file)');
console.log('  ------  ---------  -----------------------------------------------------');
for (const row of ranked.slice(0, topN)) {
  const pct = (row.bytes / total) * 100;
  const kb = row.bytes / 1024;
  const tag = row.url
    ? path.basename(row.url.replace(/^file:\/\//, ''))
    : '(no-file)';
  const fn = row.fn || '(anonymous)';
  console.log(`  ${pct.toFixed(1).padStart(5)}%  ${kb.toFixed(1).padStart(8)}  ${fn}  (${tag})`);
}
