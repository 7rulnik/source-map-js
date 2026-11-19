'use strict';

// Measures how much memory one consumer keeps once it can answer queries in
// both directions, in a fresh process, and prints it as a JSON line.
//
//   node --expose-gc benchmarks/memory.js <lib> <fixture>
//
// It counts the JS heap, memory outside the heap that V8 knows about
// (external: ArrayBuffers, Buffers), and WebAssembly memory, which
// process.memoryUsage() leaves out. The JSON string the consumer is created
// from is in memory before and after, so it isn't counted.

const { loadFixture } = require('./fixtures');
const { hasSource } = require('./helpers');
const { findLib } = require('./libs');

function settle() {
  for (let i = 0; i < 3; i++) global.gc();
}

async function used(lib) {
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external + (await lib.nonHeapBytes());
}

// The JSON string and a query in each direction, so every lazy index gets
// built. The rest of the fixture (its parsed and decoded copies) becomes
// garbage before the baseline.
function load(fixtureName) {
  const fixture = loadFixture(fixtureName);
  let original = null;
  search: for (const segments of fixture.lines) {
    for (const s of segments) {
      if (!hasSource(s)) continue;
      original = {
        source: fixture.map.sources[s[1]],
        line: s[2] + 1,
        column: s[3],
      };
      break search;
    }
  }
  return { text: fixture.text, generated: { line: 1, column: 0 }, original };
}

async function main() {
  const [libId, fixtureName] = process.argv.slice(2);
  const lib = findLib(libId).load();
  const { text, generated, original } = load(fixtureName);

  // A throwaway consumer first, so the library's one-time allocations (its
  // code, the WebAssembly instance) are part of the baseline.
  const warm = await lib.consumer(
    '{"version":3,"sources":["a.js"],"names":[],"mappings":"AAAA"}'
  );
  lib.originalPositionFor(warm, { line: 1, column: 0 });
  lib.generatedPositionFor(warm, { source: 'a.js', line: 1, column: 0 });
  lib.destroy(warm);

  settle();
  const before = await used(lib);

  const consumer = await lib.consumer(text);
  lib.originalPositionFor(consumer, generated);
  if (original) lib.generatedPositionFor(consumer, original);

  settle();
  const after = await used(lib);

  // Uses the consumer after the measurement, so it's still reachable.
  process.stdout.write(
    JSON.stringify({
      bytes: after - before,
      sources: lib.sources(consumer).length,
    }) + '\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
