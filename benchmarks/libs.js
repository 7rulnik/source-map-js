'use strict';

// The libraries `pnpm bench:compare` measures, each behind the same adapter so
// every case does the same work on all of them. An adapter makes exactly one
// call into the library per operation and passes the library's own argument
// and result objects through, so the adapter adds the same small overhead to
// every library.
//
// The libraries other than source-map-js are pinned in
// benchmarks/package.json.

const path = require('path');

const root = path.join(__dirname, '..');

// source-map-js, source-map 0.6 and @jridgewell/source-map share the
// source-map 0.6 API.
function sourceMapApi({ SourceMapConsumer, SourceMapGenerator }) {
  return {
    async: false,
    consumer: (text) => new SourceMapConsumer(text),
    destroy() {},
    originalPositionFor: (c, q) => c.originalPositionFor(q),
    generatedPositionFor: (c, q) => c.generatedPositionFor(q),
    allGeneratedPositionsFor: (c, q) => c.allGeneratedPositionsFor(q),
    eachMapping: (c, fn) => c.eachMapping(fn),
    sources: (c) => c.sources,
    generator: (options) => new SourceMapGenerator(options),
    addMapping: (g, m) => g.addMapping(m),
    toString: (g) => g.toString(),
    nonHeapBytes: async () => 0,
  };
}

const LIBS = [
  {
    id: 'smjs',
    name: 'source-map-js',
    packages: [],
    version: () => require(path.join(root, 'package.json')).version,
    load: () => sourceMapApi(require(path.join(root, 'source-map.js'))),
  },
  {
    id: 'sm-0.6',
    name: 'source-map',
    packages: ['source-map-0.6'],
    load: () => sourceMapApi(require('source-map-0.6')),
  },
  {
    id: 'sm-0.8',
    name: 'source-map',
    packages: ['source-map-0.8'],
    note: 'Rust compiled to WebAssembly. The consumer is created asynchronously and must be destroyed, and both are part of the timed work.',
    load() {
      const lib = require('source-map-0.8');
      // The module that instantiates the WebAssembly code. It's cached, so
      // this is the instance the consumers use.
      const wasm = require('source-map-0.8/lib/wasm.js');
      return {
        ...sourceMapApi(lib),
        async: true,
        consumer: (text) => new lib.SourceMapConsumer(text),
        destroy: (c) => c.destroy(),
        // WebAssembly memory isn't in process.memoryUsage(). It only grows,
        // so its size is the most the consumers have used at once.
        nonHeapBytes: async () =>
          (await wasm()).exports.memory.buffer.byteLength,
      };
    },
  },
  {
    id: 'jr-source-map',
    name: '@jridgewell/source-map',
    packages: ['@jridgewell/source-map'],
    note: "Wraps trace-mapping and gen-mapping in the source-map API. Its addMapping() skips mappings that add nothing (gen-mapping's maybeAddMapping), so it can write fewer segments than the other libraries.",
    // Why its answers differ, per case.
    differs: {
      'add-mapping': 'its addMapping() skips mappings that add nothing',
      'to-string': 'its addMapping() skips mappings that add nothing',
    },
    load: () => sourceMapApi(require('@jridgewell/source-map')),
  },
  {
    id: 'trace-mapping',
    name: '@jridgewell/trace-mapping + gen-mapping',
    packages: ['@jridgewell/trace-mapping', '@jridgewell/gen-mapping'],
    note: 'Used directly: TraceMap for consuming, GenMapping with addMapping() and toEncodedMap() for generating.',
    load() {
      const tm = require('@jridgewell/trace-mapping');
      const gm = require('@jridgewell/gen-mapping');
      return {
        async: false,
        consumer: (text) => new tm.TraceMap(text),
        destroy() {},
        originalPositionFor: (c, q) => tm.originalPositionFor(c, q),
        generatedPositionFor: (c, q) => tm.generatedPositionFor(c, q),
        allGeneratedPositionsFor: (c, q) => tm.allGeneratedPositionsFor(c, q),
        eachMapping: (c, fn) => tm.eachMapping(c, fn),
        sources: (c) => c.resolvedSources,
        generator: (options) => new gm.GenMapping(options),
        addMapping: (g, m) => gm.addMapping(g, m),
        toString: (g) => JSON.stringify(gm.toEncodedMap(g)),
        nonHeapBytes: async () => 0,
      };
    },
  },
];

for (const lib of LIBS) {
  if (!lib.version) {
    lib.version = () =>
      lib.packages.map((p) => require(`${p}/package.json`).version).join(' + ');
  }
}

// "source-map 0.8.0", "@jridgewell/trace-mapping + gen-mapping 0.3.31 + 0.3.13"
function libLabel(lib) {
  return `${lib.name} ${lib.version()}`;
}

function findLib(id) {
  const lib = LIBS.find((l) => l.id === id);
  if (!lib) throw new Error(`Unknown library ${id}`);
  return lib;
}

module.exports = { LIBS, libLabel, findLib };
